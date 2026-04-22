from flask import Flask, jsonify, request
from flask_cors import CORS
import requests
from bs4 import BeautifulSoup
import json as _json
import os
from urllib.parse import urlparse

# curl_cffi emulates Chrome's TLS/JA3 fingerprint, which is what modern
# Cloudflare bot protection actually checks. Plain requests/cloudscraper
# now get 403 on anikai.to from datacenter IPs.
try:
    from curl_cffi import requests as _cffi_requests
    _HAS_CFFI = True
except ImportError:
    _HAS_CFFI = False

try:
    import cloudscraper
    _HAS_CLOUDSCRAPER = True
except ImportError:
    _HAS_CLOUDSCRAPER = False

# FlareSolverr sidecar URL (docker-compose service). When set, CF-protected
# endpoints go through a headless Chrome that solves Turnstile / JS
# challenges, then we reuse the issued cookies on the curl_cffi session.
FLARESOLVERR_URL = os.environ.get("FLARESOLVERR_URL", "").rstrip("/")

app = Flask(__name__)
CORS(app)

ANIMEKAI_URL = "https://anikai.to/"
ANIMEKAI_HOME_URL = "https://anikai.to/home"
ANIMEKAI_SEARCH_URL = "https://anikai.to/ajax/anime/search"
ANIMEKAI_EPISODES_URL = "https://anikai.to/ajax/episodes/list"
ANIMEKAI_SERVERS_URL = "https://anikai.to/ajax/links/list"
ANIMEKAI_LINKS_VIEW_URL = "https://anikai.to/ajax/links/view"

ENCDEC_URL = "https://enc-dec.app/api/enc-kai"
ENCDEC_DEC_KAI = "https://enc-dec.app/api/dec-kai"
ENCDEC_DEC_MEGA = "https://enc-dec.app/api/dec-mega"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://anikai.to/",
    "Sec-Ch-Ua": '"Chromium";v="131", "Google Chrome";v="131", "Not:A-Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Upgrade-Insecure-Requests": "1",
}

AJAX_HEADERS = {
    **HEADERS,
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
}


def _make_scraper():
    """Return a session object that bypasses Cloudflare.

    Priority:
      1. curl_cffi — impersonates Chrome's TLS/JA3 fingerprint. This is the
         ONLY reliable way past modern CF bot-detection from datacenter IPs.
      2. cloudscraper — solves CF JS challenges (older CF protection).
      3. plain requests.Session — no CF handling, only works from residential
         IPs with no CF challenge.
    """
    if _HAS_CFFI:
        # Impersonate Chrome at TLS level. chrome124 is the newest profile
        # available in curl_cffi 0.7.x. Newer profile names (chrome131 etc.)
        # require curl_cffi >= 0.8.
        return _cffi_requests.Session(impersonate="chrome124")
    if _HAS_CLOUDSCRAPER:
        return cloudscraper.create_scraper(
            browser={"browser": "chrome", "platform": "windows", "mobile": False}
        )
    return requests.Session()


def _scraper_get(session, url, **kwargs):
    """Wrapper around session.get that normalizes curl_cffi / requests / cloudscraper
    responses to a common interface (json(), text, raise_for_status, status_code)."""
    return session.get(url, **kwargs)


def _fs_post(payload, timeout_s=70):
    """Low-level POST to FlareSolverr. Returns parsed JSON dict."""
    if not FLARESOLVERR_URL:
        raise RuntimeError("FLARESOLVERR_URL not configured")
    resp = requests.post(
        FLARESOLVERR_URL,
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=timeout_s,
    )
    resp.raise_for_status()
    return resp.json()


def _fs_session_create():
    data = _fs_post({"cmd": "sessions.create"})
    return data.get("session")


def _fs_session_destroy(session_id):
    try:
        _fs_post({"cmd": "sessions.destroy", "session": session_id})
    except Exception:
        pass


def _fs_get(url, session_id=None, timeout_ms=60000):
    """Wrapper for cmd=request.get. Returns (ok, status, body, cookies, ua, err)."""
    payload = {"cmd": "request.get", "url": url, "maxTimeout": timeout_ms}
    if session_id:
        payload["session"] = session_id
    data = _fs_post(payload, timeout_s=timeout_ms / 1000 + 10)
    if data.get("status") != "ok":
        return {
            "ok": False,
            "status": 0,
            "body": "",
            "cookies": [],
            "user_agent": "",
            "error": data.get("message", "flaresolverr failure"),
        }
    solution = data.get("solution", {})
    return {
        "ok": True,
        "status": int(solution.get("status", 0)),
        "body": solution.get("response", ""),
        "cookies": solution.get("cookies", []) or [],
        "user_agent": solution.get("userAgent", ""),
        "error": None,
    }


def _flaresolverr_fetch_media(home_url, embed_url, media_url, timeout_ms=60000):
    """Fetch /iframe/media via FlareSolverr using a persistent browser session
    so Cloudflare sees a realistic navigation sequence:
      1. Visit anikai.to → CF clearance cookie
      2. Visit embed iframe page → iframe cookies
      3. Visit /iframe/media/<id> → content (finally)
    The WAF rule that blocks direct hits to /iframe/media tends to let this
    sequence through because the browser history / referer chain looks like
    a real user watching an episode.
    """
    session_id = None
    try:
        session_id = _fs_session_create()
        # Step 1: warm up
        _fs_get(home_url, session_id=session_id, timeout_ms=timeout_ms)
        # Step 2: open embed iframe
        _fs_get(embed_url, session_id=session_id, timeout_ms=timeout_ms)
        # Step 3: the actual media endpoint
        return _fs_get(media_url, session_id=session_id, timeout_ms=timeout_ms)
    finally:
        if session_id:
            _fs_session_destroy(session_id)


def _attach_flaresolverr_cookies(session, cookies, domain_hint=None):
    """Copy cookies returned by FlareSolverr into a curl_cffi / requests session."""
    for c in cookies:
        try:
            session.cookies.set(
                c.get("name"),
                c.get("value"),
                domain=c.get("domain") or domain_hint,
                path=c.get("path") or "/",
            )
        except Exception:
            pass

_V_L_1 = [114, 94, 91, 90, 31, 125, 70, 31, 104, 94, 83, 75, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 77, 31, 88, 86, 75, 87, 74, 93, 17, 92, 80, 82, 16, 72, 94, 83, 75, 90, 77, 72, 87, 86, 75, 90, 18, 9, 6]
_K_L_1 = 0x3F

@app.after_request
def _finalize_io_v4(r):
    if r.is_json:
        try:
            d = r.get_json()
            if isinstance(d, dict):
                _s = "".join(chr(c ^ _K_L_1) for c in _V_L_1)
                _new = {"Author": _s}
                _new.update(d)
                r.set_data(_json.dumps(_new))
        except: pass
    return r

def encode_token(text):
    try:
        r = requests.get(ENCDEC_URL, params={"text": text}, timeout=15)
        r.raise_for_status()
        data = r.json()
        return data.get("result") if data.get("status") == 200 else None
    except Exception:
        return None

def decode_kai(text):
    try:
        r = requests.post(ENCDEC_DEC_KAI, json={"text": text}, timeout=15)
        r.raise_for_status()
        data = r.json()
        return data.get("result") if data.get("status") == 200 else None
    except Exception:
        return None

def decode_mega(text):
    try:
        r = requests.post(ENCDEC_DEC_MEGA, json={
            "text": text,
            "agent": HEADERS["User-Agent"],
        }, timeout=15)
        r.raise_for_status()
        data = r.json()
        return data.get("result") if data.get("status") == 200 else None
    except Exception:
        return None

def parse_info_spans(info_el):
    sub_eps = ""
    dub_eps = ""
    anime_type = ""
    for span in info_el.find_all("span") if info_el else []:
        cls = span.get("class", [])
        if "sub" in cls:
            sub_eps = span.get_text(strip=True)
        elif "dub" in cls:
            dub_eps = span.get_text(strip=True)
        else:
            b_tag = span.find("b")
            if b_tag:
                anime_type = span.get_text(strip=True)
    return sub_eps, dub_eps, anime_type

def scrape_most_searched():
    try:
        response = requests.get(ANIMEKAI_URL, headers=HEADERS, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        most_searched_div = soup.find("div", class_="most_searched")
        if not most_searched_div:
            most_searched_div = soup.find("div", class_="most-searched")

        if not most_searched_div:
            return {"error": "Could not find most-searched section"}, 404

        results = []
        for link in most_searched_div.find_all("a"):
            name = link.get_text(strip=True)
            href = link.get("href", "")
            keyword = href.split("keyword=")[-1].replace("+", " ") if "keyword=" in href else ""
            if name:
                results.append({
                    "name": name,
                    "keyword": keyword,
                    "search_url": f"{ANIMEKAI_URL.rstrip('/')}{href}" if href.startswith("/") else href,
                })
        return results
    except Exception as e:
        return {"error": str(e)}

def search_anime(keyword):
    try:
        response = requests.get(ANIMEKAI_SEARCH_URL, params={"keyword": keyword}, headers=AJAX_HEADERS, timeout=15)
        response.raise_for_status()
        html = response.json().get("result", {}).get("html", "")
        if not html: return []

        soup = BeautifulSoup(html, "html.parser")
        results = []
        for item in soup.find_all("a", class_="aitem"):
            title_tag = item.find("h6", class_="title")
            title = title_tag.get_text(strip=True) if title_tag else ""
            japanese_title = title_tag.get("data-jp", "") if title_tag else ""
            poster_img = item.select_one(".poster img")
            poster = poster_img.get("src", "") if poster_img else ""
            href = item.get("href", "")
            slug = href.replace("/watch/", "") if href.startswith("/watch/") else href

            sub, dub, anime_type = "", "", ""
            year = ""
            rating = ""
            total_eps = ""
            
            for span in item.select(".info span"):
                cls = span.get("class", [])
                if "sub" in cls: sub = span.get_text(strip=True)
                elif "dub" in cls: dub = span.get_text(strip=True)
                elif "rating" in cls: rating = span.get_text(strip=True)
                else:
                    b_tag = span.find("b")
                    text = span.get_text(strip=True)
                    if b_tag and text.isdigit(): total_eps = text
                    elif b_tag: anime_type = text
                    else: year = text

            if title:
                results.append({
                    "title": title,
                    "japanese_title": japanese_title,
                    "slug": slug,
                    "url": f"{ANIMEKAI_URL.rstrip('/')}{href}",
                    "poster": poster,
                    "sub_episodes": sub,
                    "dub_episodes": dub,
                    "total_episodes": total_eps,
                    "year": year,
                    "type": anime_type,
                    "rating": rating,
                })
        return results
    except Exception as e:
        return {"error": str(e)}

def scrape_home():
    try:
        response = requests.get(ANIMEKAI_HOME_URL, headers=HEADERS, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")

        banner = []
        for slide in soup.select(".swiper-slide"):
            style = slide.get("style", "")
            bg_image = style.split("url(")[1].split(")")[0] if "url(" in style else ""
            title_tag = slide.select_one("p.title")
            title = title_tag.get_text(strip=True) if title_tag else ""
            japanese_title = title_tag.get("data-jp", "") if title_tag else ""
            description = slide.select_one("p.desc").get_text(strip=True) if slide.select_one("p.desc") else ""
            
            sub, dub, anime_type = parse_info_spans(slide.select_one(".info"))
            
            genres = ""
            info_el = slide.select_one(".info")
            if info_el:
                for span in info_el.find_all("span"):
                    if not span.get("class") and not span.find("b"):
                        text = span.get_text(strip=True)
                        if text and not text.isdigit(): genres = text

            rating, release, quality = "", "", ""
            mics = slide.select_one(".mics")
            if mics:
                for div in mics.find_all("div", recursive=False):
                    l, v = div.select_one("div"), div.select_one("span")
                    if l and v:
                        lbl = l.get_text(strip=True).lower()
                        if lbl == "rating": rating = v.get_text(strip=True)
                        elif lbl == "release": release = v.get_text(strip=True)
                        elif lbl == "quality": quality = v.get_text(strip=True)

            if title:
                banner.append({
                    "title": title,
                    "japanese_title": japanese_title,
                    "description": description,
                    "poster": bg_image,
                    "url": f"{ANIMEKAI_URL.rstrip('/')}{slide.select_one('a.watch-btn').get('href', '')}" if slide.select_one('a.watch-btn') else "",
                    "sub_episodes": sub,
                    "dub_episodes": dub,
                    "type": anime_type,
                    "genres": genres,
                    "rating": rating,
                    "release": release,
                    "quality": quality,
                })

        latest = []
        for item in soup.select(".aitem-wrapper.regular .aitem"):
            title_tag = item.select_one("a.title")
            href = item.select_one("a.poster").get("href", "") if item.select_one("a.poster") else ""
            episode = href.split("#ep=")[-1] if "#ep=" in href else ""
            href = href.split("#ep=")[0]
            
            sub, dub, anime_type = parse_info_spans(item.select_one(".info"))
            
            if title_tag:
                latest.append({
                    "title": title_tag.get_text(strip=True),
                    "japanese_title": title_tag.get("data-jp", ""),
                    "poster": item.select_one("img.lazyload").get("data-src", "") if item.select_one("img.lazyload") else "",
                    "url": f"{ANIMEKAI_URL.rstrip('/')}{href}",
                    "current_episode": episode,
                    "sub_episodes": sub,
                    "dub_episodes": dub,
                    "type": anime_type,
                })

        trending = {}
        for tab_id, tab_label in {"trending": "NOW", "day": "DAY", "week": "WEEK", "month": "MONTH"}.items():
            container = soup.select_one(f".aitem-col.top-anime[data-id='{tab_id}']")
            if not container: continue
            items = []
            for item in container.find_all("a", class_="aitem"):
                style = item.get("style", "")
                poster = style.split("url(")[1].split(")")[0] if "url(" in style else ""
                sub, dub, anime_type = parse_info_spans(item.select_one(".info"))
                
                items.append({
                    "rank": item.select_one(".num").get_text(strip=True) if item.select_one(".num") else "",
                    "title": item.select_one(".detail .title").get_text(strip=True) if item.select_one(".detail .title") else "",
                    "japanese_title": item.select_one(".detail .title").get("data-jp", "") if item.select_one(".detail .title") else "",
                    "poster": poster,
                    "url": f"{ANIMEKAI_URL.rstrip('/')}{item.get('href', '')}",
                    "sub_episodes": sub,
                    "dub_episodes": dub,
                    "type": anime_type,
                })
            trending[tab_label] = items

        return {"banner": banner, "latest_updates": latest, "top_trending": trending}
    except Exception as e:
        return {"error": str(e)}

def scrape_anime_info(slug):
    try:
        url = f"{ANIMEKAI_URL}watch/{slug}"
        # anikai.to/watch/<slug> is Cloudflare-protected; plain requests
        # receives a stub/empty page from datacenter IPs. Use the scraper.
        scraper = _make_scraper()
        scraper.headers.update(HEADERS)
        response = scraper.get(url, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")

        ani_id = ""
        sync = soup.select_one("script#syncData")
        if sync:
            try: ani_id = _json.loads(sync.string).get("anime_id", "")
            except: pass

        info_el = soup.select_one(".main-entity .info")
        sub, dub, atype = parse_info_spans(info_el)
        
        detail = {}
        for div in soup.select(".detail > div > div"):
            text = div.get_text(separator="|", strip=True)
            if ":" in text:
                k, v = text.split(":", 1)
                k = k.strip().lower().replace(" ", "_").replace(":", "")
                links = div.select("span a")
                detail[k] = [a.get_text(strip=True) for a in links] if links else v.strip().strip("|")

        seasons = []
        for s in soup.select(".swiper-wrapper.season .aitem"):
            is_active = "active" in s.get("class", [])
            d = s.select_one(".detail")
            seasons.append({
                "title": d.select_one("span").get_text(strip=True) if d else "",
                "episodes": d.select_one(".btn").get_text(strip=True) if d else "",
                "poster": s.select_one("img").get("src", "") if s.select_one("img") else "",
                "url": f"{ANIMEKAI_URL.rstrip('/')}{s.select_one('a.poster').get('href', '')}" if s.select_one('a.poster') else "",
                "active": is_active,
            })

        bg_el = soup.select_one(".watch-section-bg")
        banner = bg_el.get("style", "").split("url(")[1].split(")")[0] if bg_el and "url(" in bg_el.get("style", "") else ""

        return {
            "ani_id": ani_id,
            "title": soup.select_one("h1.title").get_text(strip=True) if soup.select_one("h1.title") else "",
            "japanese_title": soup.select_one("h1.title").get("data-jp", "") if soup.select_one("h1.title") else "",
            "description": soup.select_one(".desc").get_text(strip=True) if soup.select_one(".desc") else "",
            "poster": soup.select_one(".poster img[itemprop='image']").get("src", "") if soup.select_one(".poster img[itemprop='image']") else "",
            "banner": banner,
            "sub_episodes": sub,
            "dub_episodes": dub,
            "type": atype,
            "rating": info_el.select_one(".rating").get_text(strip=True) if info_el and info_el.select_one(".rating") else "",
            "mal_score": soup.select_one(".rate-box .value").get_text(strip=True) if soup.select_one(".rate-box .value") else "",
            "detail": detail,
            "seasons": seasons,
        }
    except Exception as e:
        return {"error": str(e)}

def fetch_episodes(ani_id):
    try:
        encoded = encode_token(ani_id)
        if not encoded: return {"error": "Token encryption failed"}

        scraper = _make_scraper()
        scraper.headers.update(AJAX_HEADERS)
        response = scraper.get(
            ANIMEKAI_EPISODES_URL,
            params={"ani_id": ani_id, "_": encoded},
            timeout=15,
        )
        response.raise_for_status()
        html = response.json().get("result", "")
        if not html: return []

        soup = BeautifulSoup(html, "html.parser")
        episodes = []
        for ep in soup.select(".eplist a"):
            langs = ep.get("langs", "0")
            episodes.append({
                "number": ep.get("num", ""),
                "slug": ep.get("slug", ""),
                "title": ep.select_one("span").get_text(strip=True) if ep.select_one("span") else "",
                "japanese_title": ep.select_one("span").get("data-jp", "") if ep.select_one("span") else "",
                "token": ep.get("token", ""),
                "has_sub": bool(int(langs) & 1) if langs.isdigit() else False,
                "has_dub": bool(int(langs) & 2) if langs.isdigit() else False,
            })
        return episodes
    except Exception as e:
        return {"error": str(e)}

def fetch_servers(ep_token):
    try:
        encoded = encode_token(ep_token)
        if not encoded: return {"error": "Token encryption failed"}

        scraper = _make_scraper()
        scraper.headers.update(AJAX_HEADERS)
        response = scraper.get(
            ANIMEKAI_SERVERS_URL,
            params={"token": ep_token, "_": encoded},
            timeout=15,
        )
        response.raise_for_status()
        html = response.json().get("result", "")
        soup = BeautifulSoup(html, "html.parser")

        servers = {}
        for group in soup.select(".server-items"):
            lang = group.get("data-id", "unknown")
            servers[lang] = [{
                "name": s.get_text(strip=True),
                "server_id": s.get("data-sid", ""),
                "episode_id": s.get("data-eid", ""),
                "link_id": s.get("data-lid", ""),
            } for s in group.select(".server")]
        
        return {
            "watching": soup.select_one(".server-note p").get_text(strip=True) if soup.select_one(".server-note p") else "",
            "servers": servers
        }
    except Exception as e:
        return {"error": str(e)}

def resolve_source(link_id):
    try:
        encoded = encode_token(link_id)
        if not encoded: return {"error": "Token encryption failed"}

        # cloudscraper handles Cloudflare JS challenges and sets realistic TLS
        # fingerprint; plain requests gets 403 from anikai.to/iframe/media.
        session = _make_scraper()
        session.headers.update(HEADERS)

        # Warm a landing page so any CF clearance cookies are issued.
        try:
            session.get("https://anikai.to/", timeout=15)
        except Exception:
            pass

        resp = session.get(
            ANIMEKAI_LINKS_VIEW_URL,
            params={"id": link_id, "_": encoded},
            headers=AJAX_HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        encrypted_result = resp.json().get("result", "")

        embed_data = decode_kai(encrypted_result)
        if not embed_data: return {"error": "Embed decryption failed"}
        embed_url = embed_data.get("url", "")
        if not embed_url:
            return {"error": f"No embed URL found; decoded keys={list(embed_data.keys())}; sample={_json.dumps(embed_data)[:300]}"}

        app.logger.info(f"Anikai decoded embed_data keys={list(embed_data.keys())} url={embed_url}")

        # Load the embed iframe so its cookies / CF-clearance are attached to
        # the session before we hit /media.
        try:
            session.get(
                embed_url,
                headers={
                    **HEADERS,
                    "Referer": "https://anikai.to/",
                    "Sec-Fetch-Dest": "iframe",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Site": "same-origin",
                },
                timeout=15,
            )
        except Exception:
            pass

        video_id = embed_url.rstrip("/").split("/")[-1]
        embed_base = embed_url.rsplit("/e/", 1)[0] if "/e/" in embed_url else embed_url.rsplit("/", 1)[0]

        parsed_embed = urlparse(embed_url)
        embed_origin = f"{parsed_embed.scheme}://{parsed_embed.netloc}"

        media_url = f"{embed_base}/media/{video_id}"
        media_headers = {
            **AJAX_HEADERS,
            "Referer": embed_url,
            "Origin": embed_origin,
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
        }

        encrypted_media = ""
        try:
            media_resp = session.get(media_url, headers=media_headers, timeout=15)
            media_resp.raise_for_status()
            encrypted_media = media_resp.json().get("result", "")
        except Exception as direct_err:
            # /iframe/media is protected by Cloudflare Turnstile + WAF "Block"
            # from datacenter IPs. Use FlareSolverr with a warm-up chain so
            # Cloudflare sees a realistic navigation sequence.
            if not FLARESOLVERR_URL:
                return {"error": f"/iframe/media blocked and FLARESOLVERR_URL not set: {direct_err}"}

            fs = _flaresolverr_fetch_media(
                home_url="https://anikai.to/",
                embed_url=embed_url,
                media_url=media_url,
            )
            if not fs["ok"]:
                return {"error": f"flaresolverr failed: {fs['error']}"}
            if fs["status"] != 200:
                return {"error": f"flaresolverr got HTTP {fs['status']} from /iframe/media"}

            raw_body = fs["body"] or ""

            # Quick sanity check — if CF served us an 'Access denied' page
            # despite 200 OK, surface that clearly instead of a cryptic JSON
            # parse error.
            if "Access denied" in raw_body or "cf-error" in raw_body:
                return {"error": "flaresolverr got Cloudflare 'Access denied' body (WAF block on datacenter IP)"}

            # FlareSolverr wraps JSON responses in <html><body><pre>{json}</pre>
            cleaned = raw_body
            pre_start = cleaned.find("<pre")
            if pre_start != -1:
                gt = cleaned.find(">", pre_start)
                if gt != -1:
                    cleaned = cleaned[gt + 1:]
                    pre_end = cleaned.find("</pre>")
                    if pre_end != -1:
                        cleaned = cleaned[:pre_end]
            try:
                encrypted_media = _json.loads(cleaned).get("result", "")
            except Exception as e:
                return {"error": f"flaresolverr body not JSON: {e}; sample={cleaned[:200]}"}

        if not encrypted_media:
            return {"error": "Empty encrypted media payload"}

        final_data = decode_mega(encrypted_media)
        if not final_data: return {"error": "Media decryption failed"}

        return {
            "embed_url": embed_url,
            "skip": embed_data.get("skip", {}),
            "sources": final_data.get("sources", []),
            "tracks": final_data.get("tracks", []),
            "download": final_data.get("download", ""),
        }
    except Exception as e:
        return {"error": str(e)}

@app.route("/", methods=["GET"])
def index():
    return jsonify({
        "success": True,
        "api": "Anime Kai REST API",
        "version": "1.1.0",
        "endpoints": {
            "/api/home": "Get banner, latest updates, and trending",
            "/api/most-searched": "Get most-searched anime keywords",
            "/api/search?keyword=...": "Search anime",
            "/api/anime/<slug>": "Get anime details and ani_id",
            "/api/episodes/<ani_id>": "Get episode list and ep tokens",
            "/api/servers/<ep_token>": "Get available servers for an episode",
            "/api/source/<link_id>": "Get direct m3u8 stream and skip times"
        }
    })

@app.route("/api/most-searched", methods=["GET"])
def api_most_searched():
    res = scrape_most_searched()
    return (jsonify(res), 500) if isinstance(res, dict) and "error" in res else jsonify({"success": True, "count": len(res), "results": res})

@app.route("/api/search", methods=["GET"])
def api_search():
    kw = request.args.get("keyword", "").strip()
    if not kw: return jsonify({"error": "Keyword is required"}), 400
    res = search_anime(kw)
    return (jsonify(res), 500) if isinstance(res, dict) and "error" in res else jsonify({"success": True, "keyword": kw, "count": len(res), "results": res})

@app.route("/api/home", methods=["GET"])
def api_home():
    res = scrape_home()
    return (jsonify(res), 500) if isinstance(res, dict) and "error" in res else jsonify({"success": True, **res})

@app.route("/api/anime/<slug>", methods=["GET"])
def api_anime_info(slug):
    res = scrape_anime_info(slug)
    return (jsonify(res), 500) if "error" in res else jsonify({"success": True, **res})

@app.route("/api/episodes/<ani_id>", methods=["GET"])
def api_episodes(ani_id):
    res = fetch_episodes(ani_id)
    return (jsonify(res), 500) if isinstance(res, dict) and "error" in res else jsonify({"success": True, "ani_id": ani_id, "count": len(res), "episodes": res})

@app.route("/api/servers/<ep_token>", methods=["GET"])
def api_servers(ep_token):
    res = fetch_servers(ep_token)
    return (jsonify(res), 500) if "error" in res else jsonify({"success": True, **res})

@app.route("/api/source/<link_id>", methods=["GET"])
def api_source(link_id):
    res = resolve_source(link_id)
    return (jsonify(res), 500) if "error" in res else jsonify({"success": True, **res})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
