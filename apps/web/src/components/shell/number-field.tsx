import { useState, type ReactNode } from 'react';

/**
 * A number input that edits freely and applies on change when the text is a
 * number, so a user typing "5" on the way to "54" does not see "5" clamped
 * back. The shown value follows the state whenever the field is not focused.
 */
export function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onCommit,
  testId,
}: {
  readonly id?: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly suffix?: string;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
  readonly testId: string;
}): ReactNode {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const shown = draft ?? String(Number(value.toFixed(3)));
  return (
    <span className="split-number">
      <input
        {...(id === undefined ? {} : { id })}
        className="split-number__input"
        type="number"
        inputMode="decimal"
        aria-label={label}
        value={shown}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onFocus={() => {
          setDraft(shown);
        }}
        onBlur={() => {
          setDraft(undefined);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = Number(event.target.value);
          if (event.target.value !== '' && Number.isFinite(next)) onCommit(next);
        }}
        data-testid={testId}
      />
      {suffix === undefined ? null : (
        <span className="split-number__suffix" aria-hidden="true">
          {suffix}
        </span>
      )}
    </span>
  );
}
