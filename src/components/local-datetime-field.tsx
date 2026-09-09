"use client";

import { useRef } from "react";

export function LocalDateTimeField({
  id,
  name,
  label,
}: {
  id: string;
  name: string;
  label: string;
}) {
  const hidden = useRef<HTMLInputElement>(null);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="datetime-local"
        required
        onChange={(event) => {
          const raw = event.currentTarget.value;
          if (!hidden.current) return;
          if (!raw) {
            hidden.current.value = "";
            return;
          }
          const instant = new Date(raw);
          hidden.current.value = Number.isNaN(instant.getTime())
            ? ""
            : instant.toISOString();
        }}
      />
      <input ref={hidden} type="hidden" name={name} />
    </div>
  );
}
