import { Order } from "../types";

/**
 * Generates an official, compliant Zypsomart Tax Invoice Number
 */
export function generateInvoiceNumber(orderId: string): string {
  const cleanId = (orderId || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const shortCode = cleanId.slice(-6) || "000001";
  const year = new Date().getFullYear();
  return `ZYPSO-INV-${year}-${shortCode}`;
}

/**
 * Format any Firestore timestamp, string, or Date safely into a readable invoice timestamp
 */
export function formatInvoiceDateTime(val: any): string {
  if (!val) {
    return new Date().toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
  }

  let d: Date;
  if (typeof val === "object" && typeof val.toDate === "function") {
    d = val.toDate();
  } else if (typeof val === "object" && val.seconds !== undefined) {
    d = new Date(val.seconds * 1000);
  } else if (val instanceof Date) {
    d = val;
  } else {
    d = new Date(val);
  }

  if (isNaN(d.getTime())) {
    d = new Date();
  }

  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

/**
 * Helper to convert numbers to Indian Rupee Words
 */
export function numberToWordsRupees(num: number): string {
  const a = [
    "", "One ", "Two ", "Three ", "Four ", "Five ", "Six ", "Seven ", "Eight ", "Nine ",
    "Ten ", "Eleven ", "Twelve ", "Thirteen ", "Fourteen ", "Fifteen ", "Sixteen ", "Seventeen ", "Eighteen ", "Nineteen "
  ];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  const n = Math.floor(Math.abs(num));
  if (n === 0) return "Rupees Zero Only";

  const numToStr = (n: number): string => {
    if (n < 20) return a[n];
    const digit = n % 10;
    return b[Math.floor(n / 10)] + (digit ? " " + a[digit] : " ");
  };

  let str = "";
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const remaining = n % 100;

  if (crore) str += numToStr(crore) + "Crore ";
  if (lakh) str += numToStr(lakh) + "Lakh ";
  if (thousand) str += numToStr(thousand) + "Thousand ";
  if (hundred) str += a[hundred] + "Hundred ";
  if (remaining) {
    if (str) str += "and ";
    str += numToStr(remaining);
  }

  return "Rupees " + str.trim() + " Only";
}

/**
 * Generate full self-contained standalone HTML representation of an official Tax Invoice
 */
export function generateInvoiceHTML(order: Order): string {
  const invNumber = generateInvoiceNumber(order.id);
  const orderDateStr = formatInvoiceDateTime(order.createdAt);
  const printDateStr = formatInvoiceDateTime(new Date());
  const items = Array.isArray(order.items) && order.items.length > 0 ? order.items : [];
  const calculatedItemsTotal = items.reduce((acc, it) => acc + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);
  const totalAmount = Number(order.total) || calculatedItemsTotal || 0;
  const deliveryFee = 0;
  const isPaid = (order.paymentMethod || "").toLowerCase().includes("online") ||
                 (order.paymentMethod || "").toLowerCase().includes("razorpay") ||
                 order.paymentStatus === "Paid Online";

  const itemsRows = items.length > 0
    ? items.map((it, idx) => {
        const qty = Number(it.qty) || 1;
        const price = Number(it.price) || 0;
        const lineTotal = price * qty;
        return `
          <tr style="border-bottom: 1px solid #e2e8f0;">
            <td style="padding: 10px 12px; font-size: 13px; color: #475569; text-align: center;">${idx + 1}</td>
            <td style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #0f172a;">${escapeHtml(it.name || "Product Item")}</td>
            <td style="padding: 10px 12px; font-size: 13px; color: #334155; text-align: center;">${qty}</td>
            <td style="padding: 10px 12px; font-size: 13px; color: #334155; text-align: right;">₹${price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td style="padding: 10px 12px; font-size: 13px; font-weight: 700; color: #059669; text-align: right;">₹${lineTotal.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        `;
      }).join("")
    : `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 10px 12px; font-size: 13px; color: #475569; text-align: center;">1</td>
        <td style="padding: 10px 12px; font-size: 13px; font-weight: 600; color: #0f172a;">Grocery & Food Delivery Package</td>
        <td style="padding: 10px 12px; font-size: 13px; color: #334155; text-align: center;">1</td>
        <td style="padding: 10px 12px; font-size: 13px; color: #334155; text-align: right;">₹${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td style="padding: 10px 12px; font-size: 13px; font-weight: 700; color: #059669; text-align: right;">₹${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      </tr>
    `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tax Invoice - ${invNumber} - Zypsomart</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: #f8fafc; color: #1e293b; padding: 24px; }
    .invoice-card { max-width: 800px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 4px 20px rgba(0,0,0,0.06); padding: 32px; }
    .btn-bar { max-width: 800px; margin: 0 auto 16px; display: flex; justify-content: space-between; align-items: center; }
    .print-btn { background: #059669; color: #fff; border: none; padding: 10px 20px; border-radius: 10px; font-weight: 700; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 2px 8px rgba(5,150,105,0.25); }
    .print-btn:hover { background: #047857; }
    @media print {
      body { background: #fff !important; padding: 0 !important; }
      .invoice-card { border: none !important; box-shadow: none !important; border-radius: 0 !important; padding: 0 !important; width: 100% !important; max-width: 100% !important; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="btn-bar no-print">
    <div style="font-size: 13px; color: #64748b; font-weight: 600;">Zypsomart Official Tax Invoice</div>
    <div style="display: flex; gap: 8px;">
      <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
    </div>
  </div>

  <div class="invoice-card" id="printable-invoice">
    <!-- Header -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 24px; border-bottom: 2px solid #10b981;">
      <div style="display: flex; align-items: center; gap: 14px;">
        <div style="width: 48px; height: 48px; border-radius: 12px; background: #ecfdf5; border: 1.5px solid #a7f3d0; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 24px; color: #059669;">
          Z
        </div>
        <div>
          <h1 style="font-size: 24px; font-weight: 900; color: #0f172a; letter-spacing: -0.5px;">ZYPSOMART</h1>
          <p style="font-size: 11px; color: #059669; font-weight: 800; text-transform: uppercase; letter-spacing: 1px;">Grocery & Food Delivery</p>
        </div>
      </div>
      <div style="text-align: right;">
        <span style="display: inline-block; background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">
          ORIGINAL TAX INVOICE
        </span>
        <div style="font-size: 12px; color: #475569;"><strong style="color: #0f172a;">Invoice #:</strong> ${invNumber}</div>
        <div style="font-size: 12px; color: #475569;"><strong style="color: #0f172a;">Order ID:</strong> #${order.id.slice(-6).toUpperCase()}</div>
      </div>
    </div>

    <!-- Metadata Grid -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 20px 0; border-bottom: 1px solid #f1f5f9;">
      <!-- Seller Info -->
      <div style="background: #f8fafc; padding: 14px 16px; border-radius: 10px; border: 1px solid #e2e8f0;">
        <p style="font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Sold By (Merchant)</p>
        <h3 style="font-size: 14px; font-weight: 800; color: #0f172a; margin-bottom: 4px;">Zypsomart Retail Pvt. Ltd.</h3>
        <p style="font-size: 11px; color: #475569; line-height: 1.4;">Central Fulfillment Hub, Sector 4<br>Uttar Pradesh, India - 221001</p>
        <p style="font-size: 11px; color: #475569; margin-top: 4px;"><strong>GSTIN:</strong> 09AAACZ1234F1Z5 &bull; <strong>FSSAI:</strong> 12722055000123</p>
      </div>

      <!-- Customer Info -->
      <div style="background: #f8fafc; padding: 14px 16px; border-radius: 10px; border: 1px solid #e2e8f0;">
        <p style="font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">Billed & Delivered To</p>
        <h3 style="font-size: 14px; font-weight: 800; color: #0f172a; margin-bottom: 4px;">${escapeHtml(order.customerName || "Valued Customer")}</h3>
        <p style="font-size: 11px; color: #475569; margin-bottom: 3px;"><strong>Phone:</strong> ${escapeHtml(order.customerPhone || "N/A")}</p>
        <p style="font-size: 11px; color: #475569; line-height: 1.4;"><strong>Address:</strong> ${escapeHtml(order.customerAddress || "N/A")}</p>
      </div>
    </div>

    <!-- Order Dates & Payment Details -->
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 14px 0; border-bottom: 1px solid #f1f5f9; font-size: 11px;">
      <div>
        <span style="color: #64748b; font-weight: 600; display: block;">Order Placed:</span>
        <strong style="color: #0f172a;">${orderDateStr}</strong>
      </div>
      <div>
        <span style="color: #64748b; font-weight: 600; display: block;">Invoice Date:</span>
        <strong style="color: #0f172a;">${printDateStr}</strong>
      </div>
      <div>
        <span style="color: #64748b; font-weight: 600; display: block;">Payment Mode:</span>
        <strong style="color: #0f172a;">${escapeHtml(order.paymentMethod || "Cash on Delivery")}</strong>
      </div>
      <div>
        <span style="color: #64748b; font-weight: 600; display: block;">Payment Status:</span>
        <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 800; ${isPaid ? "background: #dcfce7; color: #15803d;" : "background: #fef3c7; color: #b45309;"}">
          ${isPaid ? "PAID ONLINE" : "COD (PENDING)"}
        </span>
      </div>
    </div>

    <!-- Items Table -->
    <div style="margin: 20px 0;">
      <table style="width: 100%; border-collapse: collapse; text-align: left;">
        <thead>
          <tr style="background: #f1f5f9; border-bottom: 2px solid #cbd5e1;">
            <th style="padding: 10px 12px; font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase; width: 40px; text-align: center;">#</th>
            <th style="padding: 10px 12px; font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase;">Product Description</th>
            <th style="padding: 10px 12px; font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase; text-align: center; width: 70px;">Qty</th>
            <th style="padding: 10px 12px; font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase; text-align: right; width: 110px;">Unit Price</th>
            <th style="padding: 10px 12px; font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase; text-align: right; width: 120px;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>
    </div>

    <!-- Financial Breakdown & Total -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; padding-top: 10px;">
      <!-- Notes & In Words -->
      <div style="max-width: 55%; font-size: 11px;">
        <div style="background: #f8fafc; border-radius: 8px; padding: 10px 12px; border: 1px solid #e2e8f0; margin-bottom: 8px;">
          <strong style="color: #475569; display: block; margin-bottom: 2px;">Amount in Words:</strong>
          <span style="color: #0f172a; font-weight: 700;">${numberToWordsRupees(totalAmount)}</span>
        </div>
        ${order.notes || order.customerNotes ? `
          <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 8px 12px; color: #92400e;">
            <strong>Customer Instructions:</strong> ${escapeHtml(order.notes || order.customerNotes || "")}
          </div>
        ` : ''}
      </div>

      <!-- Total Summary -->
      <div style="width: 280px; font-size: 12px;">
        <div style="display: flex; justify-content: space-between; padding: 5px 0; color: #475569;">
          <span>Items Subtotal:</span>
          <span style="font-weight: 700; color: #0f172a;">₹${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 5px 0; color: #475569;">
          <span>Delivery Charge:</span>
          <span style="font-weight: 700; color: #059669;">FREE</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 5px 0; color: #475569;">
          <span>Taxes (CGST & SGST):</span>
          <span style="font-weight: 600; color: #64748b;">Included</span>
        </div>
        <div style="border-top: 2px solid #0f172a; margin-top: 8px; padding-top: 8px; display: flex; justify-content: space-between; font-size: 15px;">
          <strong style="color: #0f172a;">Net Payable Amount:</strong>
          <strong style="color: #059669; font-size: 18px;">₹${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</strong>
        </div>
      </div>
    </div>

    <!-- Terms & Footer -->
    <div style="margin-top: 36px; padding-top: 18px; border-top: 1px dashed #cbd5e1; display: flex; justify-content: space-between; align-items: flex-end; font-size: 10px; color: #64748b;">
      <div style="max-width: 60%; line-height: 1.5;">
        <strong style="color: #334155;">Terms & Conditions:</strong>
        <p>1. Returns & replacements are accepted within 24 hours of delivery in original condition.</p>
        <p>2. For support or grievance redressal, email support@zypsomart.com or call +91 98765 43210.</p>
        <p style="margin-top: 4px; color: #94a3b8;">This is a digitally generated commercial invoice and does not require a physical signature.</p>
      </div>
      <div style="text-align: right;">
        <div style="display: inline-block; padding: 8px 14px; border: 1.5px solid #10b981; border-radius: 8px; color: #059669; font-weight: 900; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">
          ZYPSOMART VERIFIED
        </div>
        <div style="margin-top: 4px; font-weight: 600; color: #334155;">Authorized Signatory</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Trigger standalone HTML file download for offline archival or sending to customer
 */
export function downloadInvoiceAsHTML(order: Order): void {
  const htmlContent = generateInvoiceHTML(order);
  const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const cleanId = (order.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase();
  link.href = url;
  link.download = `Zypsomart-Invoice-${cleanId}.html`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Helper to trigger print dialog for standard A4 invoice
 */
export function printInvoice(order: Order): void {
  const htmlContent = generateInvoiceHTML(order);
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    // Fallback if popup blocker active: trigger window.print directly
    window.print();
    return;
  }
  printWindow.document.open();
  printWindow.document.write(htmlContent);
  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 350);
}

function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
