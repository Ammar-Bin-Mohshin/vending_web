const mqtt = require("mqtt");
const client = mqtt.connect("mqtt://localhost:1883");

let shelfStatus = { 1: false, 2: false, 3: false, 4: false, 5: false }; // Tracks heartbeat status
let lastHeartbeat = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; // Timestamp of last heartbeat
let currentShelf = null;
let currentItems = [];
let orderQueue = [];
let processing = false;
let currentResolve = null;
let currentReject = null;
let timeoutId = null;
let wsClients = [];

function setWsClients(clients) {
  wsClients = clients;
}

// Check heartbeats every 5 seconds
setInterval(() => {
  const now = Date.now();
  for (let shelf = 1; shelf <= 5; shelf++) {
    if (now - lastHeartbeat[shelf] > 30000) {
      shelfStatus[shelf] = false;
    }
  }
}, 5000);

client.on("connect", () => {
  console.log("✅ MQTT connected to broker");

  client.subscribe("vending/heartbit/+", (err) => {
    if (err) console.error("❌ Failed to subscribe to heartbit topics:", err.message);
    else console.log("📡 Subscribed to vending/heartbit/+");
  });

  client.subscribe("vending/response/+", (err) => {
    if (err) console.error("❌ Failed to subscribe to response topics:", err.message);
    else console.log("📡 Subscribed to vending/response/+");
  });
});

client.on("error", (err) => {
  console.error("❌ MQTT connection error:", err.message);
});

client.on("close", () => {
  console.log("❌ MQTT connection closed");
  for (let shelf = 1; shelf <= 5; shelf++) shelfStatus[shelf] = false;
});

client.on("message", (topic, message) => {
  try {
    if (topic.startsWith("vending/heartbit/")) {
      const shelf = parseInt(topic.split("/").pop());
      if (shelf >= 1 && shelf <= 5) {
        shelfStatus[shelf] = true;
        lastHeartbeat[shelf] = Date.now();
        console.log(`❤️ Heartbeat from shelf ${shelf}`);
      }
      return;
    }

    if (topic.startsWith("vending/response/") && currentItems.length > 0) {
      const shelf = parseInt(topic.split("/").pop());
      const response = message.toString();

      if (shelf === currentShelf) {
        console.log(`📥 Response from shelf ${shelf}: ${response}`);
        clearTimeout(timeoutId);

        const [id] = currentItems[0].split(",");
        wsClients.forEach((client) =>
          client.send(
            JSON.stringify({
              type: "orderStatus",
              id: parseInt(id),
              status: response === "success" ? "Dispensed" : "Failed",
            })
          )
        );

        currentItems.shift();
        processNextItem();
      } else {
        console.log(`⚠️ Ignoring response from shelf ${shelf}: ${response} (mismatched shelf)`);
      }
    }
  } catch (err) {
    console.error("❌ Error in MQTT message handler:", err.message);
  }
});

function sendOrderMQTT(products) {
  return new Promise((resolve, reject) => {
    const shelves = { 1: [], 2: [], 3: [], 4: [], 5: [] };

    products.forEach((p) => {
      const id = p.id;
      const quantity = p.quantity;
      if (id >= 1 && id <= 4) shelves[1].push(`${id},${quantity}`);
      else if (id >= 5 && id <= 8) shelves[2].push(`${id},${quantity}`);
      else if (id >= 9 && id <= 16) shelves[3].push(`${id},${quantity}`);
      else if (id >= 17 && id <= 24) shelves[4].push(`${id},${quantity}`);
      else if (id >= 25 && id <= 32) shelves[5].push(`${id},${quantity}`);
    });

    orderQueue = [];
    let hasItems = false;
    for (let s = 5; s >= 1; s--) {
      if (shelves[s].length > 0) {
        orderQueue.push({ shelf: s, items: shelves[s] });
        hasItems = true;
      }
    }

    if (!hasItems) {
      console.error("❌ No valid items to process");
      return reject(new Error("No valid items to process"));
    }

    currentResolve = resolve;
    currentReject = reject;
    processing = true;
    processNextShelf();
  });
}

function processNextShelf() {
  if (orderQueue.length === 0) {
    console.log("✅ All shelves processed");
    processing = false;
    wsClients.forEach((client) =>
      client.send(JSON.stringify({ type: "orderComplete", success: true }))
    );
    if (currentResolve) {
      currentResolve({ success: true });
      currentResolve = null;
      currentReject = null;
    }
    return;
  }

  const { shelf, items } = orderQueue.shift();
  currentShelf = shelf;
  currentItems = [...items];
  console.log(`➡️ Starting shelf ${currentShelf} with items:`, items);

  processNextItem();
}

function processNextItem() {
  if (currentItems.length === 0) {
    console.log(`✅ Finished shelf ${currentShelf}`);
    processNextShelf();
    return;
  }

  const item = currentItems[0];
  const [id] = item.split(",");
  console.log(`📤 Sending to shelf ${currentShelf}: ${item}`);

  if (!shelfStatus[currentShelf]) {
    console.log(`❌ Shelf ${currentShelf} disconnected`);
    wsClients.forEach((client) =>
      client.send(
        JSON.stringify({
          type: "orderStatus",
          id: parseInt(id),
          status: "Disconnected",
        })
      )
    );
    currentItems.shift();
    processNextItem();
    return;
  }

  client.publish(`vending/shelf/${currentShelf}`, item);
  wsClients.forEach((client) =>
    client.send(
      JSON.stringify({
        type: "orderStatus",
        id: parseInt(id),
        status: "Dispensing",
      })
    )
  );

  timeoutId = setTimeout(() => {
    console.log(`❌ Timeout waiting for response from shelf ${currentShelf}`);
    wsClients.forEach((client) =>
      client.send(
        JSON.stringify({
          type: "orderStatus",
          id: parseInt(id),
          status: "Failed",
        })
      )
    );
    currentItems.shift();
    processNextItem();
  }, 15000);
}

function getEsp32Status() {
  return Object.values(shelfStatus).some((status) => status);
}

module.exports = {
  sendOrderMQTT,
  getEsp32Status,
  setWsClients,
};