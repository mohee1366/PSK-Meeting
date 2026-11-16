export const USER_ROLES = ["SUPER_ADMIN", "ROOM_ADMIN", "DEPT_MANAGER", "EMPLOYEE"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export type ReservationStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "COMPLETED";
export interface SiteSummary { id: string; code: string; name: string; city: string }
export interface RoomSummary { id: string; code: string; name: string; siteId: string; capacity: number; features: string[]; isActive: boolean }
export interface ReservationSummary {
  id: string; roomId: string; title: string; startsAt: string; endsAt: string;
  status: ReservationStatus; attendeeCount: number; siteId: string;
}
export interface ApiError { error: { code: string; message: string; requestId?: string } }
