import assert from "node:assert/strict";
import test from "node:test";
import { appointmentEventSchema, decideNotification } from "../src/appointment_policy.js";

test("a reschedule becomes a patient-safe operational notification", () => {
  const event = appointmentEventSchema.parse({
    id: "evt_reschedule_42",
    type: "appointment.rescheduled",
    appointment: {
      id: "appt_42",
      patient_id: "patient_7",
      starts_at: "2026-10-03T09:30:00.000Z",
    },
  });

  assert.deepEqual(decideNotification(event), {
    event_id: "evt_reschedule_42",
    appointment_id: "appt_42",
    patient_id: "patient_7",
    template: "appointment_schedule_changed",
    starts_at: "2026-10-03T09:30:00.000Z",
  });
});

test("a confirmation is recorded without producing another patient message", () => {
  const event = appointmentEventSchema.parse({
    id: "evt_confirmed_42",
    type: "appointment.confirmed",
    appointment: {
      id: "appt_42",
      patient_id: "patient_7",
      starts_at: "2026-10-03T09:30:00.000Z",
    },
  });

  assert.equal(decideNotification(event), null);
});
