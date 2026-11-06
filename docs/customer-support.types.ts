
export enum SupportTicketStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  WAITING_FOR_CUSTOMER = 'WAITING_FOR_CUSTOMER',
  WAITING_FOR_HUMAN = 'WAITING_FOR_HUMAN',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export enum SupportPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum SupportCategory {
  ORDER_STATUS = 'ORDER_STATUS',
  DELIVERY_DELAY = 'DELIVERY_DELAY',
  MISSING_PRODUCT = 'MISSING_PRODUCT',
  DAMAGED_PRODUCT = 'DAMAGED_PRODUCT',
  WRONG_PRODUCT = 'WRONG_PRODUCT',
  PAYMENT = 'PAYMENT',
  REFUND = 'REFUND',
  RETURN = 'RETURN',
  ACCOUNT = 'ACCOUNT',
  COMPLAINT = 'COMPLAINT',
  OTHER = 'OTHER',
}

export enum SupportMessageSender {
  CUSTOMER = 'CUSTOMER',
  AI_AGENT = 'AI_AGENT',
  HUMAN_AGENT = 'HUMAN_AGENT',
  SYSTEM = 'SYSTEM',
}

export interface SupportMessage {
  id: string;
  ticketId: string;
  sender: SupportMessageSender;
  content: string;
  language?: string;
  createdAt: Date;
}

export interface SupportTicket {
  id: string;
  customerId: string;
  orderId?: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportTicketStatus;
  subject: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSupportTicketInput {
  customerId: string;
  orderId?: string;
  category: SupportCategory;
  subject: string;
  message: string;
}

export interface SupportAIResponse {
  message: string;
  requiresHumanReview: boolean;
  confidence: number;
  suggestedAction?: string;
}
