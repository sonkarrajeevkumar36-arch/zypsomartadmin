export interface OrderItem {
  name: string;
  qty: number;
  price: number;
}

export interface Order {
  id: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  total: number;
  status: string;
  orderStatus?: string;
  deliveryStatus?: string;
  items: OrderItem[];
  createdAt: any;
  updatedAt?: any;
  acceptedAt?: any;
  packagingAt?: any;
  packedAt?: any;
  onTheWayAt?: any;
  dispatchedAt?: any;
  outForDeliveryAt?: any;
  deliveredAt?: any;
  cancelledAt?: any;
  paymentMethod: string;
  paymentStatus?: string;
  notes?: string;
  customerNotes?: string;
  internalNotes?: string;
  adminNotes?: string;
  type?: string;
  returnStatus?: string;
  returnNotes?: string;
  returnRejectionReason?: string;
  returnApprovedAt?: any;
  returnRejectedAt?: any;
  isCompleted?: boolean;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  unit?: string;
  image?: string;
  imageUrl?: string;
  description?: string;
  isAvailable: boolean;
  isOffer?: boolean;
  offerType?: "percentage" | "fixed";
  offerValue?: number;
  offerPrice?: number;
  offerStartDate?: string | null;
  offerEndDate?: string | null;
  offerEnabled?: boolean;
}

export interface Category {
  id: string;
  name: string;
}
