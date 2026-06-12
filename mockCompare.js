// lib/mockCompare.js
// ============================================================
// REPLACE YOUR EXISTING mockCompare.js WITH THIS FILE
// Change BACKEND_URL to your Railway URL after deploying
// ============================================================

const BACKEND_URL = "https://your-app-name.railway.app"; // ← change this after deploying

/**
 * Compare delivery prices across DoorDash, Uber Eats, and Grubhub
 * Calls your Railway backend which runs the real scraper
 */
export async function compareDeliveryPrices(restaurantName, itemName, location) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restaurantName, itemName, location }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    return await response.json();

  } catch (error) {
    console.error("Price comparison failed:", error);

    // Fall back to mock data if backend is unreachable
    return mockFallback(restaurantName, itemName);
  }
}

/**
 * Get all restaurants matching a name across platforms
 */
export async function searchRestaurants(name, location) {
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/restaurants?name=${encodeURIComponent(name)}&location=${encodeURIComponent(location)}`
    );
    return await response.json();
  } catch (error) {
    console.error("Restaurant search failed:", error);
    return { doordash: [], ubereats: [], grubhub: [] };
  }
}

/**
 * Fallback mock data — shown if backend is unreachable
 * Keeps your app working even during downtime
 */
function mockFallback(restaurantName, itemName) {
  return {
    found:    true,
    bestDeal: "Uber Eats",
    savings:  "3.50",
    results: [
      {
        platform:      "Uber Eats",
        restaurant:    restaurantName,
        item:          itemName,
        itemPrice:     10.75,
        deliveryFee:   0.99,
        totalEstimate: 11.74,
        deliveryTime:  "20-30 min",
        rating:        4.5,
      },
      {
        platform:      "DoorDash",
        restaurant:    restaurantName,
        item:          itemName,
        itemPrice:     10.75,
        deliveryFee:   3.99,
        totalEstimate: 14.74,
        deliveryTime:  "25-35 min",
        rating:        4.4,
      },
      {
        platform:      "Grubhub",
        restaurant:    restaurantName,
        item:          itemName,
        itemPrice:     10.75,
        deliveryFee:   2.49,
        totalEstimate: 13.24,
        deliveryTime:  "30-40 min",
        rating:        4.3,
      },
    ],
  };
}
