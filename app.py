# app.py — Your backend API server
# This is what Railway will run

from flask import Flask, request, jsonify
from flask_cors import CORS
import asyncio
from price_scraper import scrape_doordash, scrape_ubereats, scrape_grubhub, compare_prices

app = Flask(__name__)
CORS(app)  # Allows Base44 frontend to call this API


@app.route("/", methods=["GET"])
def health():
    return jsonify({"status": "ok", "message": "Delivery price scraper is running"})


@app.route("/api/compare", methods=["POST"])
def compare():
    """
    POST /api/compare
    Body: { "restaurantName": "Chipotle", "itemName": "Burrito Bowl", "location": "Houston, TX" }
    Returns: { found, bestDeal, savings, results[] }
    """
    body = request.get_json()

    restaurant_name = body.get("restaurantName", "")
    item_name       = body.get("itemName", "")
    location        = body.get("location", "Houston, TX")

    if not restaurant_name or not item_name:
        return jsonify({"error": "restaurantName and itemName are required"}), 400

    # Run all 3 scrapers simultaneously
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    doordash_results, ubereats_results, grubhub_results = loop.run_until_complete(
        asyncio.gather(
            scrape_doordash(restaurant_name, location),
            scrape_ubereats(restaurant_name, location),
            scrape_grubhub(restaurant_name, location),
        )
    )

    all_results = [doordash_results, ubereats_results, grubhub_results]
    comparison  = compare_prices(restaurant_name, item_name, all_results)

    return jsonify(comparison)


@app.route("/api/restaurants", methods=["GET"])
def restaurants():
    """
    GET /api/restaurants?name=Chipotle&location=Houston,TX
    Returns list of matching restaurants across all platforms
    """
    name     = request.args.get("name", "")
    location = request.args.get("location", "Houston, TX")

    if not name:
        return jsonify({"error": "name parameter is required"}), 400

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    doordash_results, ubereats_results, grubhub_results = loop.run_until_complete(
        asyncio.gather(
            scrape_doordash(name, location),
            scrape_ubereats(name, location),
            scrape_grubhub(name, location),
        )
    )

    return jsonify({
        "doordash": doordash_results,
        "ubereats":  ubereats_results,
        "grubhub":   grubhub_results,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
