const express  = require("express");
const cors     = require("cors");
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

// ── Parse "$3.99 delivery" → 3.99 ───────────────────────────
function parsePrice(str) {
  if (!str) return null;
  const m = String(str).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

// ── Health check ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "DishPrice scraper is running" });
});

// ── DoorDash scraper ─────────────────────────────────────────
async function scrapeDoorDash(browser, restaurantName, location) {
  const results = [];
  const page    = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,mp4}", r => r.abort());

    await page.goto(
      `https://www.doordash.com/search/store/${encodeURIComponent(restaurantName)}/`,
      { waitUntil: "networkidle", timeout: 30000 }
    );
    await page.waitForTimeout(2000);

    const stores = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[data-anchor-id='StoreCard']"))
        .slice(0, 10)
        .map(c => ({
          name: c.querySelector("span[data-anchor-id='StoreHeaderName']")?.innerText || "",
          href: c.href || "",
          deliveryFee:  c.querySelector("[data-testid='DeliveryFee']")?.innerText || "",
          deliveryTime: c.querySelector("[data-testid='DeliveryEta']")?.innerText || "",
          rating:       c.querySelector("[aria-label*='Star Rating']")?.innerText || "",
        }))
    );

    for (const store of stores) {
      if (!store.href) continue;
      const menuItems = [];
      try {
        const mp = await browser.newPage();
        await mp.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2}", r => r.abort());
        await mp.goto(store.href, { waitUntil: "networkidle", timeout: 25000 });
        await mp.waitForTimeout(2000);
        const items = await mp.evaluate(() =>
          Array.from(document.querySelectorAll("[data-anchor-id='MenuItem']"))
            .slice(0, 50)
            .map(el => ({
              name:  el.querySelector("[data-anchor-id='MenuItemName']")?.innerText || "",
              price: el.querySelector("[data-testid='MenuItemPrice']")?.innerText || "",
            }))
        );
        items.forEach(i => { if (i.name) menuItems.push({ name: i.name, price: parsePrice(i.price) }); });
        await mp.close();
      } catch (e) { console.error("[DD] menu:", e.message); }

      results.push({
        platform:     "DoorDash",
        restaurant:   store.name,
        deliveryFee:  parsePrice(store.deliveryFee),
        deliveryTime: store.deliveryTime,
        rating:       store.rating,
        menu:         menuItems,
        orderUrl:     `https://www.doordash.com/search/store/${encodeURIComponent(store.name || restaurantName)}/`,
        appUrl:       `doordash://search?query=${encodeURIComponent(store.name || restaurantName)}`,
      });
    }
  } catch (e) { console.error("[DD] error:", e.message); }
  finally { await page.close(); }
  return results;
}

// ── Uber Eats scraper ────────────────────────────────────────
async function scrapeUberEats(browser, restaurantName, location) {
  const results = [];
  const page    = await browser.newPage();
  try {
    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2}", r => r.abort());
    await page.goto(
      `https://www.ubereats.com/feed?q=${encodeURIComponent(restaurantName)}&diningMode=DELIVERY`,
      { waitUntil: "networkidle", timeout: 30000 }
    );
    await page.waitForTimeout(3000);

    const stores = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid='store-card']"))
        .slice(0, 10)
        .map(c => ({
          name:         c.querySelector("h3")?.innerText || "",
          href:         c.querySelector("a")?.href || "",
          deliveryFee:  c.querySelector("[data-testid='delivery-fee']")?.innerText || "",
          deliveryTime: c.querySelector("[data-testid='eta-label']")?.innerText || "",
        }))
    );

    for (const store of stores) {
      if (!store.href) continue;
      const menuItems = [];
      try {
        const mp = await browser.newPage();
        await mp.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2}", r => r.abort());
        await mp.goto(store.href, { waitUntil: "networkidle", timeout: 25000 });
        await mp.waitForTimeout(2000);
        const items = await mp.evaluate(() =>
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
        await mp.close();
      } catch (e) { console.error("[UE] menu:", e.message); }

      results.push({
        platform:     "Uber Eats",
        restaurant:   store.name,
        deliveryFee:  parsePrice(store.deliveryFee),
        deliveryTime: store.deliveryTime,
        rating:       null,
        menu:         menuItems,
        orderUrl:     `https://www.ubereats.com/search?q=${encodeURIComponent(store.name || restaurantName)}`,
        appUrl:       `ubereats://search?q=${encodeURIComponent(store.name || restaurantName)}`,
      });
    }
  } catch (e) { console.error("[UE] error:", e.message); }
  finally { await page.close(); }
  return results;
}

// ── Grubhub scraper ──────────────────────────────────────────
async function scrapeGrubhub(restaurantName, location) {
  const results = [];
  try {
    const url = `https://api-gtm.grubhub.com/restaurants/search?orderMethod=standard&locationMode=DELIVERY&pageSize=10&hideHateos=true&queryText=${encodeURIComponent(restaurantName)}&location=${encodeURIComponent(location)}&sortSetId=umami`;
    const res  = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept":     "application/json",
        "Referer":    "https://www.grubhub.com/",
      }
    });
    const data        = await res.json();
    const restaurants = data?.search_result?.results || [];

    for (const r of restaurants.slice(0, 10)) {
      const menuItems = [];
      if (r.restaurant_id) {
        try {
          const mr   = await fetch(`https://api-gtm.grubhub.com/restaurants/${r.restaurant_id}?hideHateos=true`, {
            headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.grubhub.com/" }
          });
          const md   = await mr.json();
          const list = md?.restaurant?.menu_item_list || [];
          list.forEach(cat => {
            (cat.choice_list || []).forEach(item => {
              menuItems.push({ name: item.name, price: item.price ? item.price / 100 : null });
            });
          });
        } catch (e) { console.error("[GH] menu:", e.message); }
      }
      results.push({
        platform:     "Grubhub",
        restaurant:   r.name,
        deliveryFee:  r.delivery_fee ? r.delivery_fee / 100 : null,
        deliveryTime: r.estimated_delivery_time,
        rating:       r.ratings?.actual_rating_value || null,
        menu:         menuItems,
        orderUrl:     `https://www.grubhub.com/search?queryText=${encodeURIComponent(r.name || restaurantName)}`,
        appUrl:       `grubhub://search?query=${encodeURIComponent(r.name || restaurantName)}`,
      });
    }
  } catch (e) { console.error("[GH] error:", e.message); }
  return results;
}

// ── Price comparison engine ──────────────────────────────────
function comparePrices(restaurantName, itemName, allResults) {
  const norm  = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const tRest = norm(restaurantName);
  const tItem = norm(itemName);
  const matches = [];

  for (const platformResults of allResults) {
    for (const restaurant of platformResults) {
      if (!norm(restaurant.restaurant).includes(tRest)) continue;
      for (const item of restaurant.menu || []) {
        if (itemName && !norm(item.name).includes(tItem)) continue;
        const itemPrice = item.price  || 0;
        const delFee    = restaurant.deliveryFee || 0;
        const total     = Math.round((itemPrice + delFee) * 100) / 100;
        matches.push({
          platform:      restaurant.platform,
          restaurant:    restaurant.restaurant,
          item:          item.name,
          itemPrice,
          deliveryFee:   delFee,
          totalEstimate: total,
          deliveryTime:  restaurant.deliveryTime,
          rating:        restaurant.rating,
          orderUrl:      restaurant.orderUrl,
          appUrl:        restaurant.appUrl,
        });
      }

      // If no item specified or no menu items matched, still return restaurant info
      if (!itemName || restaurant.menu.length === 0) {
        matches.push({
          platform:      restaurant.platform,
          restaurant:    restaurant.restaurant,
          item:          null,
          itemPrice:     null,
          deliveryFee:   restaurant.deliveryFee || 0,
          totalEstimate: restaurant.deliveryFee || 0,
          deliveryTime:  restaurant.deliveryTime,
          rating:        restaurant.rating,
          orderUrl:      restaurant.orderUrl,
          appUrl:        restaurant.appUrl,
        });
      }
    }
  }

  matches.sort((a, b) => a.totalEstimate - b.totalEstimate);
  if (!matches.length) return { found: false, results: [] };

  const savings = Math.round(
    (matches[matches.length - 1].totalEstimate - matches[0].totalEstimate) * 100
  ) / 100;

  return { found: true, bestDeal: matches[0].platform, savings, results: matches };
}

// ── POST /api/compare ────────────────────────────────────────
app.post("/api/compare", async (req, res) => {
  const { restaurantName, itemName = "", location = "Houston, TX" } = req.body;
  if (!restaurantName) return res.status(400).json({ error: "restaurantName is required" });

  const cacheKey = `${restaurantName}|${itemName}|${location}`;
  const cached   = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const [dd, ue, gh] = await Promise.all([
      scrapeDoorDash(browser, restaurantName, location),
      scrapeUberEats(browser, restaurantName, location),
      scrapeGrubhub(restaurantName, location),
    ]);

    const result = comparePrices(restaurantName, itemName, [dd, ue, gh]);
    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("Compare error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ── GET /api/restaurants ─────────────────────────────────────
app.get("/api/restaurants", async (req, res) => {
  const { name, location = "Houston, TX" } = req.query;
  if (!name) return res.status(400).json({ error: "name is required" });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const [dd, ue, gh] = await Promise.all([
      scrapeDoorDash(browser, name, location),
      scrapeUberEats(browser, name, location),
      scrapeGrubhub(name, location),
    ]);
    res.json({ doordash: dd, ubereats: ue, grubhub: gh });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => console.log(`DishPrice scraper running on port ${PORT}`));
