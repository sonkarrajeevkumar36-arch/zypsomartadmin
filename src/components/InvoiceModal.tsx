import React, { useRef } from "react";
import {
  X,
  Printer,
  Download,
  FileText,
  Copy,
  CheckCircle2,
  Calendar,
  Phone,
  MapPin,
  CreditCard,
  ShieldCheck,
  Package
} from "lucide-react";
import { motion } from "motion/react";
import { Order } from "../types";
import {
  generateInvoiceNumber,
  formatInvoiceDateTime,
  numberToWordsRupees,
  downloadInvoiceAsHTML
} from "../utils/invoiceGenerator";

interface InvoiceModalProps {
  order: Order;
  onClose: () => void;
  onNotify?: (type: "success" | "error", msg: string) => void;
}

export const InvoiceModal: React.FC<InvoiceModalProps> = ({
  order,
  onClose,
  onNotify
}) => {
  const [copied, setCopied] = React.useState(false);
  const printableRef = useRef<HTMLDivElement>(null);

  const invNumber = generateInvoiceNumber(order.id);
  const orderDateStr = formatInvoiceDateTime(order.createdAt);
  const printDateStr = formatInvoiceDateTime(new Date());

  const items = Array.isArray(order.items) && order.items.length > 0 ? order.items : [];
  const calculatedItemsTotal = items.reduce(
    (acc, it) => acc + (Number(it.price) || 0) * (Number(it.qty) || 1),
    0
  );
  const totalAmount = Number(order.total) || calculatedItemsTotal || 0;
  const isPaid =
    (order.paymentMethod || "").toLowerCase().includes("online") ||
    (order.paymentMethod || "").toLowerCase().includes("razorpay") ||
    order.paymentStatus === "Paid Online";

  const handleCopyInvoiceNumber = () => {
    try {
      navigator.clipboard.writeText(invNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (onNotify) onNotify("success", `Invoice Number ${invNumber} copied to clipboard!`);
    } catch {
      // ignore
    }
  };

  const handleDirectPrint = () => {
    window.print();
  };

  const handleDownload = () => {
    downloadInvoiceAsHTML(order);
    if (onNotify) onNotify("success", `Invoice downloaded successfully as HTML file.`);
  };

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center p-2 sm:p-4 md:p-6 bg-black/60 backdrop-blur-sm overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 15 }}
        transition={{ duration: 0.2 }}
        className="bg-white rounded-3xl shadow-2xl max-w-3xl w-full my-auto overflow-hidden border border-slate-200 flex flex-col max-h-[94vh]"
      >
        {/* Top Control Header (Actions & Close) - Hidden when printing */}
        <div className="no-print bg-slate-900 text-white px-4 sm:px-6 py-3.5 flex items-center justify-between border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 flex items-center justify-center shrink-0">
              <FileText size={17} className="stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black tracking-tight truncate flex items-center gap-2">
                <span>Tax Invoice Preview</span>
                <span className="text-[10px] font-mono font-bold bg-slate-800 text-slate-300 px-2 py-0.5 rounded">
                  {invNumber}
                </span>
              </h3>
              <p className="text-[11px] text-slate-400 truncate">
                Customer copy & tax compliance record
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Print Button */}
            <button
              onClick={handleDirectPrint}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-black transition-all cursor-pointer shadow-sm active:scale-95"
              title="Print standard A4 Invoice"
            >
              <Printer size={14} className="stroke-[2.5]" />
              <span className="hidden sm:inline">Print Invoice</span>
              <span className="sm:hidden">Print</span>
            </button>

            {/* Download Button */}
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition-all cursor-pointer border border-slate-700 active:scale-95"
              title="Download standalone HTML invoice"
            >
              <Download size={14} className="stroke-[2.5]" />
              <span className="hidden sm:inline">Download</span>
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              className="p-1.5 rounded-full hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer ml-1"
              title="Close Invoice"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable Printable Invoice Content */}
        <div className="overflow-y-auto p-4 sm:p-6 md:p-8 space-y-6 bg-white text-slate-800" id="printable-invoice" ref={printableRef}>
          {/* Invoice Document Header */}
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-6 border-b-2 border-emerald-500">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-50 via-teal-50 to-emerald-100 border border-emerald-300 flex items-center justify-center font-black text-2xl text-emerald-700 shrink-0 shadow-sm">
                Z
              </div>
              <div>
                <h1 className="text-2xl font-black text-slate-900 tracking-tight leading-tight flex items-center gap-2">
                  <span>ZYPSOMART</span>
                </h1>
                <p className="text-xs font-black text-emerald-600 uppercase tracking-widest">
                  Grocery & Food Delivery
                </p>
                <p className="text-[11px] text-slate-500 font-medium">
                  Fresh Groceries & Everyday Essentials Delivered Fast
                </p>
              </div>
            </div>

            <div className="sm:text-right flex flex-col sm:items-end">
              <span className="inline-block bg-emerald-50 text-emerald-800 border border-emerald-300 px-3 py-1 rounded-md text-[11px] font-black uppercase tracking-wider mb-2">
                ORIGINAL TAX INVOICE
              </span>
              <div className="flex items-center gap-1.5 text-xs text-slate-600 mb-0.5">
                <span className="font-semibold text-slate-500">Invoice No:</span>
                <span className="font-mono font-black text-slate-900">{invNumber}</span>
                <button
                  type="button"
                  onClick={handleCopyInvoiceNumber}
                  className="no-print p-0.5 hover:text-emerald-600 cursor-pointer"
                  title="Copy Invoice Number"
                >
                  {copied ? <CheckCircle2 size={13} className="text-emerald-600" /> : <Copy size={13} />}
                </button>
              </div>
              <p className="text-xs text-slate-600">
                <span className="font-semibold text-slate-500">Order ID:</span>{" "}
                <span className="font-mono font-bold text-slate-900">#{order.id.slice(-6).toUpperCase()}</span>
              </p>
              <p className="text-[11px] text-slate-400 font-mono break-all">{order.id}</p>
            </div>
          </div>

          {/* Seller and Customer Details Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {/* Seller Details */}
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200/80">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-2 flex items-center gap-1.5">
                <ShieldCheck size={13} className="text-emerald-600" />
                <span>Sold By (Registered Merchant)</span>
              </span>
              <h4 className="text-sm font-black text-slate-900 mb-1">
                Zypsomart Retail Pvt. Ltd.
              </h4>
              <p className="text-slate-600 leading-relaxed">
                Central Fulfillment Hub, Sector 4<br />
                Uttar Pradesh, India - 221001
              </p>
              <div className="mt-2 pt-2 border-t border-slate-200/60 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                <span><strong>GSTIN:</strong> 09AAACZ1234F1Z5</span>
                <span><strong>FSSAI:</strong> 12722055000123</span>
                <span><strong>Helpline:</strong> +91 98765 43210</span>
              </div>
            </div>

            {/* Customer Details */}
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200/80">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-2 flex items-center gap-1.5">
                <MapPin size={13} className="text-emerald-600" />
                <span>Billed & Delivered To</span>
              </span>
              <h4 className="text-sm font-black text-slate-900 mb-1">
                {order.customerName || "Customer"}
              </h4>
              <p className="text-slate-700 font-bold mb-1 flex items-center gap-1">
                <Phone size={12} className="text-slate-400 shrink-0" />
                <span>{order.customerPhone || "N/A"}</span>
              </p>
              <p className="text-slate-600 leading-relaxed">
                {order.customerAddress || "Address not provided"}
              </p>
            </div>
          </div>

          {/* Timing, Payment, and Status Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50/60 rounded-xl p-3 border border-slate-200 text-xs">
            <div>
              <span className="text-slate-400 font-bold text-[10px] uppercase tracking-wider block">Order Placed</span>
              <span className="font-bold text-slate-800">{orderDateStr}</span>
            </div>
            <div>
              <span className="text-slate-400 font-bold text-[10px] uppercase tracking-wider block">Invoice Date</span>
              <span className="font-bold text-slate-800">{printDateStr}</span>
            </div>
            <div>
              <span className="text-slate-400 font-bold text-[10px] uppercase tracking-wider block">Payment Mode</span>
              <span className="font-bold text-slate-800 flex items-center gap-1">
                <CreditCard size={12} className="text-slate-400" />
                <span>{order.paymentMethod || "Cash on Delivery"}</span>
              </span>
            </div>
            <div>
              <span className="text-slate-400 font-bold text-[10px] uppercase tracking-wider block">Payment Status</span>
              <span
                className={`inline-block px-2 py-0.5 rounded text-[10px] font-black uppercase mt-0.5 ${
                  isPaid
                    ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                    : "bg-amber-100 text-amber-800 border border-amber-200"
                }`}
              >
                {isPaid ? "Paid Online" : "COD (Pending)"}
              </span>
            </div>
          </div>

          {/* Itemized Table */}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-100 text-slate-600 border-b border-slate-200">
                  <th className="py-2.5 px-3 font-extrabold uppercase text-[10px] text-center w-10">#</th>
                  <th className="py-2.5 px-3 font-extrabold uppercase text-[10px]">Product Description</th>
                  <th className="py-2.5 px-3 font-extrabold uppercase text-[10px] text-center w-16">Qty</th>
                  <th className="py-2.5 px-3 font-extrabold uppercase text-[10px] text-right w-24">Unit Price</th>
                  <th className="py-2.5 px-3 font-extrabold uppercase text-[10px] text-right w-28">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.length > 0 ? (
                  items.map((it, idx) => {
                    const qty = Number(it.qty) || 1;
                    const price = Number(it.price) || 0;
                    const lineTotal = price * qty;
                    return (
                      <tr key={idx} className="hover:bg-slate-50/70 transition-colors">
                        <td className="py-2.5 px-3 text-center text-slate-400 font-bold">{idx + 1}</td>
                        <td className="py-2.5 px-3 font-semibold text-slate-900">
                          {it.name || "Product Item"}
                        </td>
                        <td className="py-2.5 px-3 text-center font-bold text-slate-700">{qty}</td>
                        <td className="py-2.5 px-3 text-right text-slate-600 font-mono">
                          ₹{price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-2.5 px-3 text-right font-black text-emerald-700 font-mono">
                          ₹{lineTotal.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="py-2.5 px-3 text-center text-slate-400 font-bold">1</td>
                    <td className="py-2.5 px-3 font-semibold text-slate-900">
                      Grocery Delivery Package
                    </td>
                    <td className="py-2.5 px-3 text-center font-bold text-slate-700">1</td>
                    <td className="py-2.5 px-3 text-right text-slate-600 font-mono">
                      ₹{totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="py-2.5 px-3 text-right font-black text-emerald-700 font-mono">
                      ₹{totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Amount in words & Financial Summary */}
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4 pt-2">
            <div className="space-y-2 flex-1 max-w-sm text-xs">
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-200/80">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                  Amount in Words
                </span>
                <span className="font-bold text-slate-800 leading-snug">
                  {numberToWordsRupees(totalAmount)}
                </span>
              </div>

              {(order.notes || order.customerNotes) && (
                <div className="bg-amber-50 rounded-xl p-2.5 border border-amber-200/80 text-[11px] text-amber-900">
                  <span className="font-black uppercase tracking-wider text-amber-700 block text-[9px] mb-0.5">
                    Customer Instructions
                  </span>
                  <span>{order.notes || order.customerNotes}</span>
                </div>
              )}
            </div>

            {/* Calculations Box */}
            <div className="w-full sm:w-72 bg-slate-50 rounded-2xl p-4 border border-slate-200/80 text-xs space-y-2">
              <div className="flex justify-between text-slate-600">
                <span>Items Subtotal:</span>
                <span className="font-bold text-slate-900 font-mono">
                  ₹{totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>Delivery Charge:</span>
                <span className="font-black text-emerald-600 uppercase text-[11px]">FREE</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>GST (CGST + SGST):</span>
                <span className="font-medium text-slate-500">Included in Price</span>
              </div>
              <div className="border-t-2 border-slate-900 pt-2.5 mt-2 flex justify-between items-center text-sm">
                <span className="font-black text-slate-900">Grand Total:</span>
                <span className="font-black text-emerald-600 text-lg font-mono">
                  ₹{totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>

          {/* Footer & Signature Section */}
          <div className="pt-6 border-t border-dashed border-slate-300 flex flex-col sm:flex-row justify-between items-end gap-4 text-[10px] text-slate-500">
            <div className="space-y-1 max-w-md">
              <h5 className="font-extrabold text-slate-700 uppercase tracking-wide">
                Terms & Customer Instructions:
              </h5>
              <p>1. Returns/replacements accepted within 24 hours of delivery in original condition.</p>
              <p>2. For queries, contact support@zypsomart.com or call our toll-free helpdesk.</p>
              <p className="text-slate-400 pt-1">
                This is a digitally generated commercial invoice and does not require a physical signature.
              </p>
            </div>

            <div className="text-right shrink-0">
              <div className="inline-block px-3 py-1.5 border-1.5 border-emerald-500 rounded-lg text-emerald-700 font-black text-[10px] uppercase tracking-wider bg-emerald-50">
                ✓ Digitally Verified
              </div>
              <p className="text-[11px] font-bold text-slate-700 mt-1">For Zypsomart Retail Pvt. Ltd.</p>
              <p className="text-[9px] text-slate-400">Authorized Signatory</p>
            </div>
          </div>
        </div>

        {/* Bottom Actions Bar (Mobile touch-friendly) */}
        <div className="no-print bg-slate-50 px-4 sm:px-6 py-3 border-t border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <p className="text-xs text-slate-500 hidden sm:block">
            Order Status: <span className="font-black uppercase text-emerald-700">{order.status}</span>
          </p>

          <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
            <button
              onClick={handleDownload}
              className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-4 py-2.5 bg-white hover:bg-slate-100 text-slate-700 font-bold rounded-xl border border-slate-300 transition-all text-xs cursor-pointer shadow-2xs active:scale-95"
            >
              <Download size={15} />
              <span>Download HTML</span>
            </button>

            <button
              onClick={handleDirectPrint}
              className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl transition-all text-xs cursor-pointer shadow-md shadow-emerald-600/20 active:scale-95"
            >
              <Printer size={15} />
              <span>Print / Save PDF</span>
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
