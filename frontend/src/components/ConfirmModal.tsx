"use client";

import { useId } from "react";
import { Modal } from "@/components/Modal";

export interface ConfirmDetail {
  label: string;
  value: string;
}

/**
 * Last stop before a transaction, stating plainly what it will do.
 *
 * Every one of these actions costs gas and several move money, so the dialog
 * lists the concrete effects rather than asking "are you sure?". `irreversible`
 * gets its own warning line, because two of these — locking escrow and
 * releasing a payout — cannot be undone by anything in this app.
 */
export function ConfirmModal({
  open,
  onCancel,
  onConfirm,
  title,
  summary,
  details,
  effects,
  confirmLabel,
  irreversible,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  /** One sentence: what this does, in the user's terms. */
  summary: string;
  /** The concrete values going on chain. */
  details?: ConfirmDetail[];
  /** What will happen, in order, after they confirm. */
  effects: string[];
  confirmLabel: string;
  irreversible?: string;
}) {
  const titleId = useId();

  return (
    <Modal open={open} onClose={onCancel} labelledBy={titleId}>
      <h2 id={titleId} className="text-xl font-semibold text-surface-100">
        {title}
      </h2>
      <p className="mt-3 leading-relaxed text-surface-300">{summary}</p>

      {details?.length ? (
        <dl className="mt-6 divide-y divide-surface-800 border border-surface-800">
          {details.map((detail) => (
            <div
              key={detail.label}
              className="flex items-baseline justify-between gap-4 px-4 py-3"
            >
              <dt className="text-sm text-surface-500">{detail.label}</dt>
              <dd className="text-right text-sm break-all text-surface-200">
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-6">
        <p className="text-xs tracking-[0.15em] text-surface-500 uppercase">
          What happens next
        </p>
        <ol className="mt-3 space-y-2">
          {effects.map((effect, index) => (
            <li key={effect} className="flex gap-3 text-sm text-surface-400">
              <span className="text-surface-600 tabular-nums">
                {index + 1}
              </span>
              <span className="leading-relaxed">{effect}</span>
            </li>
          ))}
        </ol>
      </div>

      {irreversible ? (
        <p className="mt-5 border border-status-progress/30 bg-status-progress/5 p-3 text-sm leading-relaxed text-surface-300">
          {irreversible}
        </p>
      ) : null}

      <div className="mt-7 flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="border border-surface-700 px-4 py-2 text-sm text-surface-300 transition-colors hover:border-surface-600 hover:text-surface-100"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="bg-orchid-600 px-5 py-2 text-sm text-white transition-colors hover:bg-orchid-500"
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
