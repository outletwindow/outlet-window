import { describe, expect, it } from "vitest";
import { transitionCourierTask, type CourierTask } from "./courier-task.js";
const task: CourierTask = { id:"task-1",tenantId:"tenant-1",orderId:"order-1",suborderId:"suborder-1",courierId:"courier-1",status:"offered",version:0,updatedAtUtc:"2026-11-17T08:00:00.000Z" };
const context = { actorId:"courier-1",actorRole:"courier" as const,expectedVersion:0,occurredAtUtc:"2026-11-17T08:01:00+03:00" };
describe("courier task lifecycle", () => {
 it("accepts an offer and increments its optimistic version", () => {
  expect(transitionCourierTask(task,"accepted",context)).toMatchObject({ok:true,previousStatus:"offered",task:{status:"accepted",version:1,updatedAtUtc:"2026-11-17T05:01:00.000Z"}});
 });
 it("prevents another courier from accepting this task", () => {
  expect(transitionCourierTask(task,"accepted",{...context,actorId:"courier-2"})).toEqual({ok:false,reason:"actor_not_assigned"});
 });
 it("rejects stale writes and invalid status jumps", () => {
  expect(transitionCourierTask(task,"accepted",{...context,expectedVersion:1})).toEqual({ok:false,reason:"version_conflict"});
  expect(transitionCourierTask(task,"delivered",context)).toEqual({ok:false,reason:"invalid_transition"});
 });
 it("requires verified pickup evidence", () => {
  const arrived={...task,status:"arrived_at_pickup" as const,version:3};
  expect(transitionCourierTask(arrived,"picked_up",{...context,expectedVersion:3})).toEqual({ok:false,reason:"pickup_code_not_verified"});
  expect(transitionCourierTask(arrived,"picked_up",{...context,expectedVersion:3,pickupCodeVerified:true})).toMatchObject({ok:true,task:{status:"picked_up",version:4}});
 });
 it("requires delivery proof before completion", () => {
  const arrived={...task,status:"arrived_at_dropoff" as const,version:6};
  expect(transitionCourierTask(arrived,"delivered",{...context,expectedVersion:6})).toEqual({ok:false,reason:"delivery_proof_missing"});
  expect(transitionCourierTask(arrived,"delivered",{...context,expectedVersion:6,deliveryProofVerified:true})).toMatchObject({ok:true,task:{status:"delivered",version:7}});
 });
 it("requires reasons for decline and cancellation", () => {
  expect(transitionCourierTask(task,"declined",context)).toEqual({ok:false,reason:"reason_required"});
  expect(transitionCourierTask(task,"declined",{...context,reason:"vehicle_unavailable"})).toMatchObject({ok:true,task:{status:"declined"}});
 });
 it("limits dispatchers to cancellation and failure", () => {
  expect(transitionCourierTask(task,"accepted",{...context,actorId:"dispatcher-1",actorRole:"dispatcher"})).toEqual({ok:false,reason:"role_not_allowed"});
  expect(transitionCourierTask({...task,status:"accepted"},"cancelled",{...context,actorId:"dispatcher-1",actorRole:"dispatcher",reason:"dispatch_reassigned"})).toMatchObject({ok:true,task:{status:"cancelled"}});
 });
 it("rejects invalid timestamps", () => {
  expect(transitionCourierTask(task,"accepted",{...context,occurredAtUtc:"not-a-date"})).toEqual({ok:false,reason:"invalid_timestamp"});
 });
});
