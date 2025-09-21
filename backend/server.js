const bcrypt = require("bcrypt");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const path = require("path");
const WebSocket = require("ws");

const {
  getAllProducts,
  updateProduct,
  placeOrder,
  getAdminByUsername,
  getAdminById,
  updateAdminPasswordAndUsername,
} = require("./models");
const { sendOrderMQTT, getEsp32Status, setWsClients } = require("./mqtt");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = 5000;

// WebSocket server
const wss = new WebSocket.Server({ port: 5000 });
const wsClients = [];

wss.on("connection", (ws) => {
  console.log("✅ WebSocket client connected");
  wsClients.push(ws);

  ws.on("close", () => {
    console.log("❌ WebSocket client disconnected");
    const index = wsClients.indexOf(ws);
    if (index !== -1) wsClients.splice(index, 1);
  });
});

// Pass WebSocket clients to mqtt.js
setWsClients(wsClients);

async function authenticateAdmin(req, res, next) {
  const adminId = req.body.adminId || req.query.adminId;
  if (!adminId) {
    console.log("Authentication failed: No adminId provided");
    return res.status(401).json({ error: "Unauthorized: No adminId provided" });
  }

  try {
    const admin = await new Promise((resolve, reject) => {
      getAdminById(adminId, (err, row) => {
        if (err) {
          console.error("Error fetching admin by ID:", err.message);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
    if (!admin) {
      console.log(`Authentication failed: No admin found for adminId: ${adminId}`);
      return res.status(401).json({ error: "Unauthorized: Invalid adminId" });
    }
    req.admin = admin;
    next();
  } catch (err) {
    console.error("Authentication error:", err.message);
    res.status(500).json({ error: `Server error during authentication: ${err.message}` });
  }
}

app.get("/api/products", (req, res) => {
  getAllProducts((err, rows) => {
    if (err) {
      console.error("Error fetching products:", err.message);
      res.status(500).json({ error: `Failed to fetch products: ${err.message}` });
    } else {
      res.json(rows);
    }
  });
});

app.put("/api/products/:id", authenticateAdmin, (req, res) => {
  const { id } = req.params;
  const { name, price, quantity } = req.body;

  updateProduct(id, name, price, quantity, null, (err, row) => {
    if (err) {
      console.error(`Error updating product ${id}:`, err.message);
      res.status(500).json({ success: false, message: `Failed to update product: ${err.message}` });
    } else {
      res.json(row);
    }
  });
});

app.post("/api/order", async (req, res) => {
  const orderProducts = req.body.products;
  if (!orderProducts || !Array.isArray(orderProducts) || orderProducts.length === 0) {
    console.log("Order failed: Invalid or empty products array");
    return res.status(400).json({ success: false, message: "Invalid or empty products array" });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      placeOrder(orderProducts, (err, result) => {
        if (err) {
          console.error("Error placing order in database:", err.message);
          reject(new Error(`Database error: ${err.message}`));
        } else {
          resolve(result);
        }
      });
    });

    await sendOrderMQTT(orderProducts);
    console.log("Order placed successfully:", orderProducts);
    res.json({ success: true, message: "Order placed and processed by vending machine" });
  } catch (err) {
    console.error("Order error:", err.message);
    res.status(500).json({ success: false, message: `Order failed: ${err.message}` });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "public/images")),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });
app.use("/images", express.static(path.join(__dirname, "public/images")));

app.post("/api/products/:id/image", authenticateAdmin, upload.single("image"), (req, res) => {
  const { id } = req.params;
  const image = `/images/${req.file.filename}`;

  updateProduct(id, null, null, null, image, (err, row) => {
    if (err) {
      console.error(`Error updating product image ${id}:`, err.message);
      res.status(500).json({ success: false, message: `Failed to update product image: ${err.message}` });
    } else {
      res.json({ success: true, image });
    }
  });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    console.log("Login failed: Missing username or password");
    return res.status(400).json({ success: false, message: "Username and password are required" });
  }

  try {
    const admin = await new Promise((resolve, reject) => {
      getAdminByUsername(username, (err, row) => {
        if (err) {
          console.error("Error querying admin by username:", err.message);
          reject(new Error(`Database error: ${err.message}`));
        }
        if (!row) {
          console.log(`No admin found for username: ${username}`);
          return resolve(false);
        }
        bcrypt.compare(password, row.password, (err, match) => {
          if (err) {
            console.error("Error comparing passwords:", err.message);
            reject(new Error(`Password comparison error: ${err.message}`));
          }
          if (match) {
            console.log(`Successful login for username: ${username}`);
            resolve(row);
          } else {
            console.log(`Password mismatch for username: ${username}`);
            resolve(false);
          }
        });
      });
    });

    if (!admin) {
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }

    res.json({
      success: true,
      message: "Login successful",
      adminId: admin.id,
      username: admin.username,
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ success: false, message: `Server error during login: ${err.message}` });
  }
});

app.put("/api/admin", authenticateAdmin, async (req, res) => {
  const { currentPassword, newUsername, newPassword, adminId } = req.body;

  try {
    const admin = await new Promise((resolve, reject) => {
      getAdminById(adminId, (err, row) => {
        if (err) {
          console.error("Error fetching admin:", err.message);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });

    if (!admin) {
      console.log(`Admin update failed: No admin found for adminId: ${adminId}`);
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    const valid = await bcrypt.compare(currentPassword, admin.password);
    if (!valid) {
      console.log(`Admin update failed: Incorrect current password for adminId: ${adminId}`);
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }

    const hashedPassword = newPassword ? await bcrypt.hash(newPassword, 10) : admin.password;
    const updatedUsername = newUsername || admin.username;

    await new Promise((resolve, reject) => {
      updateAdminPasswordAndUsername(adminId, updatedUsername, hashedPassword, (err) => {
        if (err) {
          console.error("Error updating admin:", err.message);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    console.log(`Admin credentials updated for adminId: ${adminId}`);
    res.json({ success: true, message: "Admin credentials updated successfully" });
  } catch (err) {
    console.error("Admin update error:", err.message);
    res.status(500).json({ success: false, message: `Failed to update admin credentials: ${err.message}` });
  }
});

app.get("/api/esp32-status", (req, res) => {
  res.json({ connected: getEsp32Status() });
});

app.listen(5001, () => {
  console.log(`Backend running on http://localhost:5001`);
});