"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, TextInput } from "@/components/ui/forms";
import { updateSettingAction } from "@/server/actions/settings";
import type { SettingView } from "@/server/services/system-settings";
import { SectionCard, primaryButtonClass } from "./ui";

/**
 * Settings editor (Phase 6, Super Admin only — settings.manage).
 * Every field validates server-side with strict bounds; idle-timeout
 * and MFA values are live security gates, so errors are shown inline
 * at the field and nothing is saved on failure.
 */
export function SettingsEditor({ settings }: { settings: SettingView[] }) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  async function save(key: string, value: unknown) {
    setErrors((current) => ({ ...current, [key]: "" }));
    setNotice(null);
    setBusyKey(key);
    try {
      const result = await updateSettingAction(key, value);
      if (!result.success) {
        setErrors((current) => ({ ...current, [key]: result.error }));
        return;
      }
      setNotice(`Saved ${key}.`);
      router.refresh();
    } catch {
      setErrors((current) => ({ ...current, [key]: "Something went wrong. Please try again." }));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <div className="rounded-md border border-line bg-greenbg px-3 py-2 text-[13px] text-ink">
          {notice}
        </div>
      ) : null}
      {settings.map((setting) => (
        <SectionCard key={setting.key} title={setting.key}>
          <p className="mb-3 text-[13px] text-slate2">{setting.description}</p>
          {setting.kind === "hours" ? (
            <HoursForm
              setting={setting}
              busy={busyKey === setting.key}
              error={errors[setting.key] || undefined}
              onSave={(value) => save(setting.key, value)}
            />
          ) : null}
          {setting.kind === "boolean" ? (
            <BooleanForm
              setting={setting}
              busy={busyKey === setting.key}
              error={errors[setting.key] || undefined}
              onSave={(value) => save(setting.key, value)}
            />
          ) : null}
          {setting.kind === "tracking-config" ? (
            <TrackingForm
              setting={setting}
              busy={busyKey === setting.key}
              error={errors[setting.key] || undefined}
              onSave={(value) => save(setting.key, value)}
            />
          ) : null}
        </SectionCard>
      ))}
    </div>
  );
}

function HoursForm({
  setting,
  busy,
  error,
  onSave,
}: {
  setting: SettingView;
  busy: boolean;
  error?: string;
  onSave: (value: number) => void;
}) {
  const [value, setValue] = useState(String(setting.value as number));
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(Number(value));
  }
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <div className="w-56">
        <TextInput
          label="Idle timeout (hours)"
          type="number"
          min={setting.bounds?.min}
          max={setting.bounds?.max}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={error}
          hint={`Whole hours, ${setting.bounds?.min}–${setting.bounds?.max}. Default ${String(setting.defaultValue)}.`}
        />
      </div>
      <button type="submit" disabled={busy} className={primaryButtonClass}>
        Save
      </button>
    </form>
  );
}

function BooleanForm({
  setting,
  busy,
  error,
  onSave,
}: {
  setting: SettingView;
  busy: boolean;
  error?: string;
  onSave: (value: boolean) => void;
}) {
  const [value, setValue] = useState(Boolean(setting.value));
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(value);
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <Field label="MFA required for privileged roles" error={error}>
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={value}
            onChange={(e) => setValue(e.target.checked)}
            aria-label="MFA required for privileged roles"
          />
          <span>
            {value
              ? "Required — Super Admin and Admin must enrol and pass TOTP"
              : "Not required"}
          </span>
        </label>
      </Field>
      <div>
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          Save
        </button>
      </div>
    </form>
  );
}

function TrackingForm({
  setting,
  busy,
  error,
  onSave,
}: {
  setting: SettingView;
  busy: boolean;
  error?: string;
  onSave: (value: Record<string, number>) => void;
}) {
  const fields = setting.trackingFields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.field, String(f.value)])),
  );

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Send only fields the operator actually changed — the service
    // merges the patch over the stored override and rejects the whole
    // patch if any sent field is invalid.
    const patch: Record<string, number> = {};
    for (const f of fields) {
      const raw = values[f.field] ?? String(f.value);
      if (raw !== String(f.value)) patch[f.field] = Number(raw);
    }
    onSave(patch);
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <TextInput
            key={f.field}
            label={f.field}
            type="number"
            min={f.min}
            max={f.max}
            step={f.integer ? 1 : "any"}
            value={values[f.field] ?? String(f.value)}
            onChange={(e) => setValues((current) => ({ ...current, [f.field]: e.target.value }))}
            hint={`${f.min}–${f.max}${f.integer ? ", whole numbers" : ""}. Default ${f.defaultValue}.`}
          />
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-[12px] font-medium text-reddeep">
          {error}
        </p>
      ) : null}
      <div>
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          Save tracking config
        </button>
      </div>
    </form>
  );
}
