# ============================================================
# DELIVERY PRICE SCRAPER — No Apify needed, runs directly
# ============================================================
# SETUP:
#   pip install playwright httpx fake-useragent
#   playwright install chromium
#
# RUN:
#   python price_scraper.py
# ============================================================

import asyncio
import json
import re
import httpx
from fake_useragent import UserAgent
from playwright.async_api import async_playwright


ua = UserAgent()

# ============================================================
# UTILITIES
# ============================================================

def to_dollars(value):
    """Convert cents to dollars if value looks like cents."""
    if value is None:
        return None
    return round(value / 100, 2) if value > 100 else round(value, 2)

def clean_price(price_str):
    """Strip $ and convert price string to float."""
    if not price_str:
        return None
    match = re.search(r"[\d.]+", str(price_str).replace(",", ""))
    return float(match.group()) if match else None


# ============================================================
# DOORDASH SCRAPER
# Uses DoorDash's internal search API (public, no login needed)
# ============================================================

async def scrape_doordash(restaurant_name: str, location: str) -> list:
    """
    Calls DoorDash's internal search endpoint.
    Returns list of restaurants with menu items and prices.
    """
    results = []
    headers = {
        "User-Agent": ua.random,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.doordash.com/",
    }

    # Step 1: Search for the restaurant
    search_url = (
        f"https://www.doordash.com/graphql/getSearchFeedQuery"
        f"?operation=getSearchFeedQuery"
    )

    payload = {
        "operationName": "getSearchFeedQuery",
        "variables": {
            "query": restaurant_name,
            "pickup": False,
        },
        "query": """
            query getSearchFeedQuery($query: String!, $pickup: Boolean) {
              searchFeed(query: $query, pickup: $pickup) {
                stores {
                  id
                  name
                  deliveryFee
                  deliveryTime
                  averageRating
                  menuItems {
                    id
                    name
                    price
                    description
                  }
                }
              }
            }
        """
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(search_url, json=payload, headers=headers)
            data = res.json()
            stores = data.get("data", {}).get("searchFeed", {}).get("stores", [])

            for store in stores[:3]:  # limit to top 3 results
                menu_items = []
                for item in store.get("menuItems", []):
                    menu_items.append({
                        "name":        item.get("name"),
                        "price":       to_dollars(item.get("price")),
                        "description": item.get("description", ""),
                    })

                results.append({
                    "platform":     "DoorDash",
                    "restaurant":   store.get("name"),
                    "deliveryFee":  to_dollars(store.get("deliveryFee")),
                    "deliveryTime": store.get("deliveryTime"),
                    "rating":       store.get("averageRating"),
                    "menu":         menu_items,
                })

    except Exception as e:
        print(f"[DoorDash] Error: {e}")

    return results


# ============================================================
# UBER EATS SCRAPER
# Uses Playwright to render the JS page and extract prices
# ============================================================

async def scrape_ubereats(restaurant_name: str, location: str) -> list:
    """
    Uses headless browser to load Uber Eats search results.
    Extracts restaurant cards and menu prices.
    """
    results = []
    search_url = (
        f"https://www.ubereats.com/feed"
        f"?diningMode=DELIVERY&pl=JTdCJTIyYWRkcmVzcyUyMiUzQSUyMiUyMiU3RA%3D%3D"
        f"&q={restaurant_name.replace(' ', '%20')}"
    )

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent=ua.random,
                viewport={"width": 1280, "height": 800},
                locale="en-US",
            )
            page = await context.new_page()

            # Block images/fonts to speed up scraping
            await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2}", 
                           lambda r: r.abort())

            await page.goto(search_url, wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(3000)

            # Extract restaurant data from page
            restaurants = await page.evaluate("""
                () => {
                    const cards = document.querySelectorAll('[data-testid="store-card"]');
                    const data = [];
                    cards.forEach(card => {
                        const name = card.querySelector('h3, [data-testid="rich-text"]');
                        const fee  = card.querySelector('[data-testid="delivery-fee"]');
                        const time = card.querySelector('[data-testid="eta-label"]');
                        const rating = card.querySelector('[aria-label*="stars"]');
                        const link = card.querySelector('a');
                        data.push({
                            name:        name ? name.innerText : null,
                            deliveryFee: fee  ? fee.innerText  : null,
                            deliveryTime:time ? time.innerText : null,
                            rating:      rating ? rating.getAttribute('aria-label') : null,
                            href:        link ? link.href : null,
                        });
                    });
                    return data;
                }
            """)

            # For each restaurant, get menu items
            for r in restaurants[:2]:  # limit to top 2 to stay fast
                if not r.get("href"):
                    continue

                menu_items = []
                try:
                    menu_page = await context.new_page()
                    await menu_page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2}",
                                        lambda req: req.abort())
                    await menu_page.goto(r["href"], wait_until="networkidle", 
                                        timeout=25000)
                    await menu_page.wait_for_timeout(2000)

                    items = await menu_page.evaluate("""
                        () => {
                            const items = document.querySelectorAll(
                                '[data-testid="menu-item"]'
                            );
                            const data = [];
                            items.forEach(item => {
                                const name  = item.querySelector(
                                    '[data-testid="rich-text"]'
                                );
                                const price = item.querySelector(
                                    '[data-testid="menu-item-price"]'
                                );
                                const desc  = item.querySelectorAll(
                                    '[data-testid="rich-text"]'
                                )[1];
                                data.push({
                                    name:        name  ? name.innerText  : null,
                                    price:       price ? price.innerText : null,
                                    description: desc  ? desc.innerText  : null,
                                });
                            });
                            return data.slice(0, 20); // top 20 items
                        }
                    """)

                    for item in items:
                        menu_items.append({
                            "name":        item.get("name"),
                            "price":       clean_price(item.get("price")),
                            "description": item.get("description", ""),
                        })

                    await menu_page.close()

                except Exception as e:
                    print(f"[Uber Eats] Menu error for {r.get('name')}: {e}")

                results.append({
                    "platform":     "Uber Eats",
                    "restaurant":   r.get("name"),
                    "deliveryFee":  clean_price(r.get("deliveryFee")),
                    "deliveryTime": r.get("deliveryTime"),
                    "rating":       r.get("rating"),
                    "menu":         menu_items,
                })

            await browser.close()

    except Exception as e:
        print(f"[Uber Eats] Error: {e}")

    return results


# ============================================================
# GRUBHUB SCRAPER
# Uses Grubhub's internal REST API (public endpoint)
# ============================================================

async def scrape_grubhub(restaurant_name: str, location: str) -> list:
    """
    Calls Grubhub's search API directly.
    No login required for public menu/price data.
    """
    results = []

    # Grubhub exposes a public search endpoint
    search_url = (
        f"https://api-gtm.grubhub.com/restaurants/search"
        f"?orderMethod=standard"
        f"&locationMode=DELIVERY"
        f"&facetSet=umamiV2"
        f"&pageSize=5"
        f"&hideHateos=true"
        f"&searchMetrics=true"
        f"&queryText={restaurant_name.replace(' ', '+')}"
        f"&location={location.replace(' ', '+')}"
        f"&preciseLocation=false"
        f"&sortSetId=umami"
        f"&sponsoredSize=3"
        f"&countOmittedRestaurants=true"
    )

    headers = {
        "User-Agent":  ua.random,
        "Accept":      "application/json",
        "Referer":     "https://www.grubhub.com/",
        "Origin":      "https://www.grubhub.com",
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(search_url, headers=headers)
            data = res.json()
            restaurants = data.get("search_result", {}).get("results", [])

            for r in restaurants[:3]:
                restaurant_id = r.get("restaurant_id")
                menu_items = []

                # Fetch menu for this restaurant
                if restaurant_id:
                    menu_url = (
                        f"https://api-gtm.grubhub.com/restaurants/{restaurant_id}"
                        f"?hideHateos=true"
                    )
                    try:
                        menu_res = await client.get(menu_url, headers=headers)
                        menu_data = menu_res.json()
                        restaurant_data = menu_data.get("restaurant", {})

                        for category in restaurant_data.get("menu_item_list", []):
                            for item in category.get("choice_list", []):
                                menu_items.append({
                                    "name":        item.get("name"),
                                    "price":       to_dollars(item.get("price")),
                                    "description": item.get("description", ""),
                                })

                    except Exception as e:
                        print(f"[Grubhub] Menu fetch error: {e}")

                results.append({
                    "platform":     "Grubhub",
                    "restaurant":   r.get("name"),
                    "deliveryFee":  to_dollars(r.get("delivery_fee")),
                    "deliveryTime": r.get("estimated_delivery_time"),
                    "rating":       r.get("ratings", {}).get("actual_rating_value"),
                    "menu":         menu_items,
                })

    except Exception as e:
        print(f"[Grubhub] Error: {e}")

    return results


# ============================================================
# PRICE COMPARISON ENGINE
# Finds a specific item across all platforms and ranks by total
# ============================================================

def compare_prices(restaurant_name: str, item_name: str, all_results: list) -> dict:
    """
    Fuzzy-matches restaurant and item name across all platforms.
    Returns ranked results sorted by total cost (item + delivery fee).
    """
    def normalize(s):
        return s.lower().replace(" ", "").replace("-", "") if s else ""

    target_restaurant = normalize(restaurant_name)
    target_item       = normalize(item_name)
    matches           = []

    for platform_results in all_results:
        for restaurant in platform_results:
            if target_restaurant not in normalize(restaurant.get("restaurant", "")):
                continue

            for item in restaurant.get("menu", []):
                if not item.get("name"):
                    continue
                if target_item not in normalize(item["name"]):
                    continue

                item_price   = item.get("price") or 0
                delivery_fee = restaurant.get("deliveryFee") or 0
                total        = round(item_price + delivery_fee, 2)

                matches.append({
                    "platform":     restaurant["platform"],
                    "restaurant":   restaurant["restaurant"],
                    "item":         item["name"],
                    "itemPrice":    item_price,
                    "deliveryFee":  delivery_fee,
                    "totalEstimate":total,
                    "deliveryTime": restaurant.get("deliveryTime"),
                    "rating":       restaurant.get("rating"),
                })

    # Sort cheapest first
    matches.sort(key=lambda x: x["totalEstimate"])

    if not matches:
        return {"found": False, "results": []}

    cheapest      = matches[0]
    most_expensive = matches[-1]
    savings       = round(most_expensive["totalEstimate"] - 
                         cheapest["totalEstimate"], 2)

    return {
        "found":    True,
        "bestDeal": cheapest["platform"],
        "savings":  savings,
        "results":  matches,
    }


# ============================================================
# MAIN — Run a comparison search
# ============================================================

async def main():
    restaurant_name = "Chipotle"
    item_name       = "Burrito Bowl"
    location        = "Houston, TX"

    print(f"\nSearching for '{item_name}' at '{restaurant_name}' in {location}...")
    print("Running all 3 scrapers simultaneously...\n")

    # Run all 3 scrapers at the same time
    doordash_results, ubereats_results, grubhub_results = await asyncio.gather(
        scrape_doordash(restaurant_name, location),
        scrape_ubereats(restaurant_name, location),
        scrape_grubhub(restaurant_name, location),
    )

    all_results = [doordash_results, ubereats_results, grubhub_results]

    # Compare prices
    comparison = compare_prices(restaurant_name, item_name, all_results)

    # Print results
    print("=" * 50)
    if not comparison["found"]:
        print("No matching items found across platforms.")
    else:
        print(f"BEST DEAL: {comparison['bestDeal']}")
        print(f"YOU SAVE:  ${comparison['savings']} vs most expensive\n")
        for r in comparison["results"]:
            print(f"  {r['platform']:<12} | "
                  f"Item: ${r['itemPrice']:.2f} | "
                  f"Delivery: ${r['deliveryFee']:.2f} | "
                  f"Total: ${r['totalEstimate']:.2f} | "
                  f"ETA: {r['deliveryTime']}")

    # Also save full raw data to JSON for inspection
    with open("raw_results.json", "w") as f:
        json.dump(all_results, f, indent=2)
    print("\nFull raw data saved to raw_results.json")


if __name__ == "__main__":
    asyncio.run(main())
