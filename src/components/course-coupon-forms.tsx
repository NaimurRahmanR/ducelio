"use client";
import { useActionState, useState } from "react";
import {
  createCouponAction,
  toggleCouponAction,
} from "@/app/admin/course-engineering/coupons/actions";
export function CreateCourseCouponForm({
  courses,
  organisations = [],
}: {
  courses: { id: string; title: string }[];
  organisations?: { id: string; name: string; canManage: boolean }[];
}) {
  const [state, action, pending] = useActionState(createCouponAction, {});
  const [kind, setKind] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  return (
    <form action={action} className="acad-form">
      <fieldset disabled={pending}>
        <legend>Create course coupon</legend>
        {organisations.length > 0 && (
          <label>
            Organisation
            <select name="organisationId" required>
              {organisations
                .filter((o) => o.canManage)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </select>
          </label>
        )}
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
          Discount type
          <select
            name="discountKind"
            value={kind}
            onChange={(e) =>
              setKind(e.target.value === "AMOUNT" ? "AMOUNT" : "PERCENT")
            }
          >
            <option value="PERCENT">Percentage of the course price</option>
            <option value="AMOUNT">Fixed amount in one currency</option>
          </select>
        </label>
        {kind === "PERCENT" ? (
          <label>
            Discount percentage
            <input name="percentOff" type="number" required min={1} max={100} />
          </label>
        ) : (
          <>
            <label>
              Fixed discount (for example 25.00)
              <input
                name="amountOff"
                inputMode="decimal"
                required
                pattern="\d{1,6}(\.\d{1,2})?"
              />
            </label>
            <label>
              Currency (applies only to courses priced in it)
              <select name="currency" required defaultValue="GBP">
                <option value="GBP">GBP</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </label>
          </>
        )}
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
