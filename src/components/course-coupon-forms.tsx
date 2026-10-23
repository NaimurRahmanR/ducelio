"use client";
import { useActionState } from "react";
import {
  createCouponAction,
  toggleCouponAction,
} from "@/app/admin/course-engineering/coupons/actions";
export function CreateCourseCouponForm({
  courses,
}: {
  courses: { id: string; title: string }[];
}) {
  const [state, action, pending] = useActionState(createCouponAction, {});
  return (
    <form action={action} className="acad-form">
      <fieldset disabled={pending}>
        <legend>Create course coupon</legend>
        <label>
          Code
          <input
            name="code"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9_-]{3,39}"
            maxLength={40}
          />
        </label>
        <label>
          Discount percentage
          <input name="percentOff" type="number" required min={1} max={100} />
        </label>
        <label>
          Expiry (UTC)
          <input name="expiresAt" type="datetime-local" required />
        </label>
        <label>
          Total redemption limit
          <input
            name="redemptionLimit"
            type="number"
            required
            min={1}
            max={1000000}
          />
        </label>
        <label>
          Course restriction
          <select name="courseId">
            <option value="">All courses in the unified catalogue</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reason for the record
          <input name="reason" required minLength={5} maxLength={300} />
        </label>
        <button className="ac-button">
          {pending ? "Creating…" : "Create coupon"}
        </button>
      </fieldset>
      {(state.error || state.message) && (
        <p role={state.error ? "alert" : "status"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
export function ToggleCourseCouponForm({
  id,
  active,
}: {
  id: string;
  active: boolean;
}) {
  const [state, action, pending] = useActionState(toggleCouponAction, {});
  return (
    <form action={action} className="acad-form">
      <input type="hidden" name="couponId" value={id} />
      <input type="hidden" name="active" value={String(!active)} />
      <label>
        Reason for availability change
        <input name="reason" required minLength={5} maxLength={300} />
      </label>
      <button className="ac-button secondary" disabled={pending}>
        {active ? "Deactivate coupon" : "Activate coupon"}
      </button>
      {(state.error || state.message) && (
        <p role={state.error ? "alert" : "status"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
