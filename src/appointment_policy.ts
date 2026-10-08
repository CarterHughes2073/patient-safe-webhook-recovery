import { z } from "zod";

export const appointmentEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["appointment.confirmed", "appointment.rescheduled", "appointment.cancelled"]),
  appointment: z.object({
    id: z.string().min(1),
    patient_id: z.string().min(1),
    starts_at: z.string().datetime(),
  }),
});

export type AppointmentEvent = z.infer<typeof appointmentEventSchema>;

export type OperationalNotification = {
  event_id: string;
  appointment_id: string;
  patient_id: string;
  template: "appointment_schedule_changed" | "appointment_cancelled";
  starts_at: string;
};

export function decideNotification(event: AppointmentEvent): OperationalNotification | null {
  if (event.type === "appointment.confirmed") return null;
  return {
    event_id: event.id,
    appointment_id: event.appointment.id,
    patient_id: event.appointment.patient_id,
    template: event.type === "appointment.cancelled"
      ? "appointment_cancelled"
      : "appointment_schedule_changed",
    starts_at: event.appointment.starts_at,
  };
}
