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
  items: OrderItem[];
  createdAt: any;
  updatedAt?: any;
  paymentMethod: string;
  notes?: string;
  customerNotes?: string;
  type?: string;
  returnStatus?: string;
  returnNotes?: string;
  returnRejectionReason?: string;
  returnApprovedAt?: any;
  returnRejectedAt?: any;
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
}

export interface Category {
  id: string;
  name: string;
}
