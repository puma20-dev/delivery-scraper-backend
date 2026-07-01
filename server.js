const express      = require("express");
const cors         = require("cors");
const { chromium } = require("playwright");

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// ── Cache (15 min) ───────────────────────────────────────────
const cache  = new Map();
const TTL_MS = 15 * 60 * 1000;
function getCached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  return null;
}
function setCached(key, data) { cache.set(key, { data, ts: Date.now() }); }
function parsePrice(str) {
  if (!str) return null;
  const m = String(str).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

app.get("/", (req, res) => res.json({ status: "ok", message: "DishPrice running" }));


// ============================================================
// GET ALL restaurants near a location from DoorDash
// Uses DoorDash's browse-by-location page, not search
// ============================================================
async function getAllDoorDash(browser, lat, lng, query = "") {
  const results = [];
  const page    = await browser.newPage();
  try {
    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,mp4}", r => r.abort());

    // DoorDash home feed uses lat/lng to show nearby restaurants
    const url = query
      ? `https://www.doordash.com/search/store/${encodeURIComponent(query)}/?lat=${lat}&lng=${lng}`
      : `https://www.doordash.com/?lat=${lat}&lng=${lng}`;

    await page.goto(url, { waitUntil: "networkidle", timeout: 35000 });
    await page.waitForTimeout(3000);

    // Scroll to load more restaurants
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(1000);
    }

    const stores = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[data-anchor-id='StoreCard']"))
        .map(c => ({
          name:         c.querySelector("span[data-anchor-id='StoreHeaderName']")?.innerText?.trim() || "",
          href:         c.href || "",
          deliveryFee:  c.querySelector("[data-testid='DeliveryFee']")?.innerText || "",
          deliveryTime: c.querySelector("[data-testid='DeliveryEta']")?.innerText || "",
          rating:       c.querySelector("[aria-label*='Star Rating']")?.innerText || "",
          cuisine:      c.querySelector("[data-testid='StoreCuisine']")?.innerText || "",
        }))
        .filter(s => s.name && s.href)
    );

    console.log(`[DoorDash] Found ${stores.length} restaurants`);

    for (const store of stores.slice(0, 30)) {
      results.push({
        platform:     "DoorDash",
        restaurant:   store.name,
        cuisine:      store.cuisine,
        deliveryFee:  parsePrice(store.deliveryFee),
        deliveryTime: store.deliveryTime,
        rating:       store.rating,
        menu:         [],
        orderUrl:     store.href,
        appUrl:       `doordash://store/${encodeURIComponent(store.name)}`,
      });
    }
  } catch (e) { console.error("[DD] error:", e.message); }
  finally { await page.close(); }
  return results;
}


// ============================================================
// GET ALL restaurants near a location from Uber Eats
// ============================================================
async function getAllUberEats(browser, lat, lng, query = "") {
  const results = [];
  const page    = await browser.newPage();
  try {
    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,mp4}", r => r.abort());

    const url = query
      ? `https://www.ubereats.com/feed?diningMode=DELIVERY&pl=JTdCJTIybGF0aXR1ZGUlMjIlM0Eke2xhdH0lMkMlMjJsb25naXR1ZGUlMjIlM0Eke2xuZ30lN0Q%3D&q=${encodeURIComponent(query)}`
      : `https://www.ubereats.com/feed?diningMode=DELIVERY&pl=JTdCJTIybGF0aXR1ZGUlMjIlM0Eke2xhdH0lMkMlMjJsb25naXR1ZGUlMjIlM0Eke2xuZ30lN0Q%3D`;

    // Use a location-encoded URL
    const locationUrl = `https://www.ubereats.com/feed?diningMode=DELIVERY&userLat=${lat}&userLng=${lng}${query ? `&q=${encodeURIComponent(query)}` : ""}`;

    await page.goto(locationUrl, { waitUntil: "networkidle", timeout: 35000 });
    await page.waitForTimeout(3000);

    // Scroll to load more
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(1000);
    }

    const stores = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid='store-card']"))
        .map(c => ({
          name:         c.querySelector("h3")?.innerText?.trim() || "",
          href:         c.querySelector("a")?.href || "",
          deliveryFee:  c.querySelector("[data-testid='delivery-fee']")?.innerText || "",
          deliveryTime: c.querySelector("[data-testid='eta-label']")?.innerText || "",
          tag:          c.querySelector("[data-testid='tag-text']")?.innerText || "",
        }))
        .filter(s => s.name && s.href)
    );

    console.log(`[UberEats] Found ${stores.length} restaurants`);

    for (const store of stores.slice(0, 30)) {
      results.push({
        platform:     "Uber Eats",
        restaurant:   store.name,
        cuisine:      store.tag,
        deliveryFee:  parsePrice(store.deliveryFee),
        deliveryTime: store.deliveryTime,
        rating:       null,
        menu:         [],
        orderUrl:     store.href,
        appUrl:       `ubereats://search?q=${encodeURIComponent(store.name)}`,
      });
    }
  } catch (e) { console.error("[UE] error:", e.message); }
  finally { await page.close(); }
  return results;
}


// ============================================================
// GET ALL restaurants near a location from Grubhub
// ============================================================
async function getAllGrubhub(lat, lng, query = "") {
  const results = [];
  try {
    const url = `https://api-gtm.grubhub.com/restaurants/search?orderMethod=standard&locationMode=DELIVERY&facetSet=umamiV2&pageSize=40&hideHateos=true&queryText=${encodeURIComponent(query || "food")}&latitude=${lat}&longitude=${lng}&sortSetId=umami&sponsoredSize=3&countOmittedRestaurants=true`;

    const res  = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept":     "application/json",
        "Referer":    "https://www.grubhub.com/",
      }
    });
    const data        = await res.json();
    const restaurants = data?.search_result?.results || [];
    console.log(`[Grubhub] Found ${restaurants.length} restaurants`);

    for (const r of restaurants) {
      results.push({
        platform:     "Grubhub",
        restaurant:   r.name,
        cuisine:      r.cuisines?.[0] || "",
        deliveryFee:  r.delivery_fee ? r.delivery_fee / 100 : null,
        deliveryTime: r.estimated_delivery_time,
        rating:       r.ratings?.actual_rating_value || null,
        menu:         [],
        orderUrl:     `https://www.grubhub.com/restaurant/${r.restaurant_id}`,
        appUrl:       `grubhub://restaurant/${r.restaurant_id}`,
      });
    }
  } catch (e) { console.error("[GH] error:", e.message); }
  return results;
}


// ============================================================
// GET menu for a specific restaurant on a specific platform
// ============================================================
async function getMenu(browser, platform, orderUrl, restaurantName) {
  const menuItems = [];
  const page      = await browser.newPage();
  try {
    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,mp4}", r => r.abort());
    await page.goto(orderUrl, { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(2000);

    if (platform === "DoorDash") {
      const items = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-anchor-id='MenuItem']"))
          .slice(0, 50)
          .map(el => ({
            name:  el.querySelector("[data-anchor-id='MenuItemName']")?.innerText || "",
            price: el.querySelector("[data-testid='MenuItemPrice']")?.innerText || "",
          }))
      );
      items.forEach(i => { if (i.name) menuItems.push({ name: i.name, price: parsePrice(i.price) }); });

    } else if (platform === "Uber Eats") {
      const items = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-testid='menu-item']"))
          .slice(0, 50)
          .map(el => {
            const texts = el.querySelectorAll("[data-testid='rich-text']");
            return {
              name:  texts[0]?.innerText || "",
              price: el.querySelector("[data-testid='menu-item-price']")?.innerText || "",
            };
          })
      );
      items.forEach(i => { if (i.name) menuItems.push({ name: i.name, price: parsePrice(i.price) }); });
    }
  } catch (e) { console.error(`[Menu] error for ${restaurantName}:`, e.message); }
  finally { await page.close(); }
  return menuItems;
}


// ============================================================
// GET /api/nearby-all
// Returns ALL restaurants within ~20 miles using GPS coords
// Query: ?lat=29.76&lng=-95.36&query=pizza (query optional)
// ============================================================
app.get("/api/nearby-all", async (req, res) => {
  const { lat, lng, query = "", location = "Houston, TX" } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: "lat and lng are required" });
  }

  const cacheKey = `nearby-all|${lat}|${lng}|${query}`;
  const cached   = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    // Get all restaurants from all 3 platforms simultaneously
    const [dd, ue, gh] = await Promise.all([
      getAllDoorDash(browser, lat, lng, query),
      getAllUberEats(browser, lat, lng, query),
      getAllGrubhub(lat, lng, query),
    ]);

    // Merge and deduplicate by restaurant name
    const allRestaurants = {};

    [...dd, ...ue, ...gh].forEach(r => {
      const key = r.restaurant.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!allRestaurants[key]) {
        allRestaurants[key] = {
          name:      r.restaurant,
          cuisine:   r.cuisine,
          platforms: [],
        };
      }
      allRestaurants[key].platforms.push({
        platform:     r.platform,
        deliveryFee:  r.deliveryFee,
        deliveryTime: r.deliveryTime,
        rating:       r.rating,
        orderUrl:     r.orderUrl,
        appUrl:       r.appUrl,
      });
    });

    // Sort by number of platforms available (most available first)
    const sorted = Object.values(allRestaurants)
      .sort((a, b) => b.platforms.length - a.platforms.length);

    const result = {
      found:       sorted.length > 0,
      total:       sorted.length,
      restaurants: sorted,
    };

    setCached(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error("Nearby-all error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});


// ============================================================
// POST /api/compare — Compare prices for a specific item
// Body: { restaurantName, itemName, location, lat, lng }
// ============================================================
app.post("/api/compare", async (req, res) => {
  const { restaurantName, itemName = "", location = "Houston, TX", lat, lng } = req.body;
  if (!restaurantName) return res.status(400).json({ error: "restaurantName is required" });

  const cacheKey = `compare|${restaurantName}|${itemName}|${lat}|${lng}`;
  const cached   = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const [dd, ue, gh] = await Promise.all([
      getAllDoorDash(browser, lat || 29.76, lng || -95.36, restaurantName),
      getAllUberEats(browser, lat || 29.76, lng || -95.36, restaurantName),
      getAllGrubhub(lat || 29.76, lng || -95.36, restaurantName),
    ]);

    // Find matching restaurants and get their menus
    const norm    = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const tRest   = norm(restaurantName);
    const matches = [];

    for (const r of [...dd, ...ue, ...gh]) {
      if (!norm(r.restaurant).includes(tRest)) continue;

      // Fetch the menu for this specific restaurant
      let menu = [];
      if (r.orderUrl && (r.platform === "DoorDash" || r.platform === "Uber Eats")) {
        menu = await getMenu(browser, r.platform, r.orderUrl, r.restaurant);
      } else if (r.platform === "Grubhub") {
        // Use Grubhub API for menu
        const id = r.orderUrl?.split("/").pop();
        if (id) {
          try {
            const mr   = await fetch(`https://api-gtm.grubhub.com/restaurants/${id}?hideHateos=true`, {
              headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.grubhub.com/" }
            });
            const md   = await mr.json();
            const list = md?.restaurant?.menu_item_list || [];
            list.forEach(cat => {
              (cat.choice_list || []).forEach(item => {
                menu.push({ name: item.name, price: item.price ? item.price / 100 : null });
              });
            });
          } catch (e) { console.error("[GH] menu error:", e.message); }
        }
      }

      for (const item of menu) {
        if (itemName && !norm(item.name).includes(norm(itemName))) continue;
        const itemPrice = item.price  || 0;
        const delFee    = r.deliveryFee || 0;
        matches.push({
          platform:      r.platform,
          restaurant:    r.restaurant,
          item:          item.name,
          itemPrice,
          deliveryFee:   delFee,
          totalEstimate: Math.round((itemPrice + delFee) * 100) / 100,
          deliveryTime:  r.deliveryTime,
          rating:        r.rating,
          orderUrl:      r.orderUrl,
          appUrl:        r.appUrl,
        });
      }

      if (menu.length === 0) {
        matches.push({
          platform:      r.platform,
          restaurant:    r.restaurant,
          item:          null,
          itemPrice:     null,
          deliveryFee:   r.deliveryFee || 0,
          totalEstimate: r.deliveryFee || 0,
          deliveryTime:  r.deliveryTime,
          rating:        r.rating,
          orderUrl:      r.orderUrl,
          appUrl:        r.appUrl,
        });
      }
    }

    matches.sort((a, b) => a.totalEstimate - b.totalEstimate);

    const result = {
      found:    matches.length > 0,
      bestDeal: matches[0]?.platform,
      savings:  matches.length > 1
        ? Math.round((matches[matches.length-1].totalEstimate - matches[0].totalEstimate) * 100) / 100
        : 0,
      results: matches,
    };

    setCached(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error("Compare error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});


app.listen(PORT, () => console.log(`DishPrice running on port ${PORT}`));
