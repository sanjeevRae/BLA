import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";

/**
 * Server-safe form primitives (V2 Phase 1 design system).
 * `useId` is allowed in server components and is used only to
 * generate stable ids when the caller does not supply one.
 */

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label?: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  const hintId = htmlFor && hint ? `${htmlFor}-hint` : undefined;
  const errorId = htmlFor && error ? `${htmlFor}-error` : undefined;
  return (
    <div className="grid gap-1.5">
      {label ? (
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
          {label}
          {required ? (
            <span aria-hidden="true" className="text-red">
              {" *"}
            </span>
          ) : null}
        </label>
      ) : null}
      {children}
      {hint ? (
        <p id={hintId} className="text-[12px] text-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-[12px] font-medium text-reddeep">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedByFor(id: string, hint?: string, error?: string): string | undefined {
  const parts: string[] = [];
  if (hint) parts.push(`${id}-hint`);
  if (error) parts.push(`${id}-error`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function controlBorder(error?: string): string {
  return error ? "border-red" : "border-line";
}

export type TextInputProps = {
  label?: string;
  error?: string;
  hint?: string;
} & InputHTMLAttributes<HTMLInputElement>;

export function TextInput({
  label,
  error,
  hint,
  id: idProp,
  required,
  className,
  ...props
}: TextInputProps) {
  const generatedId = useId().replace(/:/g, "");
  const id = idProp ?? generatedId;
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint} required={required}>
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByFor(id, hint, error)}
        className={`min-h-[44px] w-full rounded-md border bg-surface px-3 text-[13px] text-ink ${controlBorder(error)} ${className ?? ""}`}
        {...props}
      />
    </Field>
  );
}

export type TextAreaProps = {
  label?: string;
  error?: string;
  hint?: string;
} & TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea({
  label,
  error,
  hint,
  id: idProp,
  required,
  className,
  ...props
}: TextAreaProps) {
  const generatedId = useId().replace(/:/g, "");
  const id = idProp ?? generatedId;
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint} required={required}>
      <textarea
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByFor(id, hint, error)}
        className={`w-full rounded-md border bg-surface px-3 py-2 text-[13px] text-ink ${controlBorder(error)} ${className ?? ""}`}
        {...props}
      />
    </Field>
  );
}

export type SelectProps = {
  label?: string;
  error?: string;
  hint?: string;
  children?: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>;

export function Select({
  label,
  error,
  hint,
  id: idProp,
  required,
  className,
  children,
  ...props
}: SelectProps) {
  const generatedId = useId().replace(/:/g, "");
  const id = idProp ?? generatedId;
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint} required={required}>
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByFor(id, hint, error)}
        className={`min-h-[44px] w-full rounded-md border bg-surface px-3 text-[13px] text-ink ${controlBorder(error)} ${className ?? ""}`}
        {...props}
      >
        {children}
      </select>
    </Field>
  );
}
