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
  INCORRECT_PRODUCT = 'INCORRECT_PRODUCT',
  DAMAGED_PRODUCT = 'DAMAGED_PRODUCT',
  PAYMENT_ISSUE = 'PAYMENT_ISSUE',
  REFUND_REQUEST = 'REFUND_REQUEST',
  RETURN_REQUEST = 'RETURN_REQUEST',
  EXCHANGE_REQUEST = 'EXCHANGE_REQUEST',
  MERCHANT_COMPLAINT = 'MERCHANT_COMPLAINT',
  COURIER_COMPLAINT = 'COURIER_COMPLAINT',
  SHOPPER_ISSUE = 'SHOPPER_ISSUE',
  ACCOUNT_ISSUE = 'ACCOUNT_ISSUE',
  TECHNICAL_ISSUE = 'TECHNICAL_ISSUE',
  OTHER = 'OTHER',
}

export enum SupportSenderType {
  CUSTOMER = 'CUSTOMER',
  AI_AGENT = 'AI_AGENT',
  HUMAN_AGENT = 'HUMAN_AGENT',
  MERCHANT = 'MERCHANT',
  COURIER = 'COURIER',
  SHOPPER = 'SHOPPER',
  SYSTEM = 'SYSTEM',
}

export enum SupportMessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  FILE = 'FILE',
  SYSTEM_EVENT = 'SYSTEM_EVENT',
}

export enum SupportResolutionType {
  ANSWERED = 'ANSWERED',
  REFUNDED = 'REFUNDED',
  REPLACED = 'REPLACED',
  ESCALATED = 'ESCALATED',
  CANCELLED = 'CANCELLED',
  OTHER = 'OTHER',
}

export interface SupportAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileUrl: string;
  fileSize: number;
  uploadedAt: Date;
}

export interface SupportMessage {
  id: string;
  ticketId: string;
  senderType: SupportSenderType;
  senderId: string;
  messageType: SupportMessageType;
  content: string;
  attachments?: SupportAttachment[];
  isInternal: boolean;
  createdAt: Date;
}

export interface SupportTicket {
  id: string;
  ticketNumber: string;
  customerId: string;
  orderId?: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportTicketStatus;
  subject: string;
  description: string;
  assignedAgentId?: string;
  assignedHumanAgentId?: string;
  messages: SupportMessage[];
  resolutionType?: SupportResolutionType;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSupportTicketInput {
  customerId: string;
  orderId?: string;
  category: SupportCategory;
  subject: string;
  description: string;
  attachments?: SupportAttachment[];
}

export interface SendSupportMessageInput {
  ticketId: string;
  senderType: SupportSenderType;
  senderId: string;
  content: string;
  messageType?: SupportMessageType;
  attachments?: SupportAttachment[];
}

export interface SupportAIResponse {
  answer: string;
  confidence: number;
  requiresHumanReview: boolean;
  escalationReason?: string;
  suggestedCategory?: SupportCategory;
  suggestedPriority?: SupportPriority;
  suggestedActions?: string[];
}

export interface SupportEscalationRule {
  category: SupportCategory;
  minimumPriority: SupportPriority;
  requiresHumanApproval: boolean;
  reason: string;
}

export interface SupportServiceMetrics {
  totalTickets: number;
  openTickets: number;
  resolvedTickets: number;
  escalatedTickets: number;
  averageFirstResponseTimeSeconds: number;
  averageResolutionTimeSeconds: number;
  customerSatisfactionScore?: number;
}
