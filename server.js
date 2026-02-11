require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_ENV = process.env.CASHFREE_ENV || "SANDBOX";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CASHFREE_API_URL =
  CASHFREE_ENV === "PRODUCTION"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

const CASHFREE_HEADERS = {
  "Content-Type": "application/json",
  "x-client-id": CASHFREE_APP_ID,
  "x-client-secret": CASHFREE_SECRET_KEY,
  "x-api-version": "2022-09-01",
};

// --- API 1: CREATE PAYMENT (Fixed 50 Rs) ---
app.post("/api/payment/create", async (req, res) => {
  try {
    const { applicationId, customerPhone, customerName } = req.body;

    if (!applicationId || !customerPhone) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: applicationId or customerPhone",
      });
    }

    const FIXED_AMOUNT = 30.0;
    const orderId = `ORD_${applicationId}_${Date.now()}`;

    // Cashfree Payload
    const payload = {
      order_amount: FIXED_AMOUNT,
      order_currency: "INR",
      order_id: orderId,
      customer_details: {
        customer_id: `CUST_${applicationId}`,
        customer_phone: String(customerPhone),
        customer_name: customerName || "Applicant",
      },
      order_meta: {
        return_url: `https://www.r2ps.in/payment-status.html?order_id=${orderId}`,
      },
    };

    // 1. Create Order at Cashfree
    const cfResponse = await axios.post(`${CASHFREE_API_URL}/orders`, payload, {
      headers: CASHFREE_HEADERS,
    });

    // 2. Update Supabase
    const { error: dbError } = await supabase
      .from("application_entries")
      .update({
        payment_order_id: orderId,
        payment_amount: String(FIXED_AMOUNT),
        payment_status: "PENDING",
      })
      .eq("id", applicationId);

    if (dbError) throw new Error("Database update failed: " + dbError.message);

    // 3. Success Response
    res.status(200).json({
      success: true,
      payment_session_id: cfResponse.data.payment_session_id,
      order_id: orderId,
      amount: FIXED_AMOUNT,
    });
  } catch (error) {
    console.error("Create Error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// --- API 2: VERIFY PAYMENT (Check Status) ---
app.post("/api/payment/verify", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res
        .status(400)
        .json({ success: false, message: "Order ID is required" });
    }

    console.log(`🔍 Verifying Order: ${orderId}`);

    // 1. Get Status from Cashfree
    const response = await axios.get(`${CASHFREE_API_URL}/orders/${orderId}`, {
      headers: CASHFREE_HEADERS,
    });

    const cashfreeStatus = response.data.order_status; // "PAID", "ACTIVE", "EXPIRED", "FAILED"

    // 2. Map Status to Database Value
    let dbStatus = "PENDING";
    if (cashfreeStatus === "PAID") dbStatus = "COMPLETE";
    else if (cashfreeStatus === "FAILED" || cashfreeStatus === "EXPIRED")
      dbStatus = "FAILED";

    // 3. Update Database Status
    // We update based on payment_order_id since we might not have the app ID handy here
    const { data, error } = await supabase
      .from("application_entries")
      .update({
        payment_status: dbStatus,
      })
      .eq("payment_order_id", orderId)
      .select();

    if (error) {
      console.error("Supabase Verify Error:", error);
      throw new Error("Failed to update payment status in database.");
    }

    console.log(`✅ Order ${orderId} marked as ${dbStatus}`);

    // 4. Send Response
    res.status(200).json({
      success: true,
      status: dbStatus, // "COMPLETE", "PENDING", or "FAILED"
      cashfree_status: cashfreeStatus,
      order_id: orderId,
    });
  } catch (error) {
    console.error("Verify Error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Verification failed",
    });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
