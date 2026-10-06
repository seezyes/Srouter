"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import PropTypes from "prop-types";

export default function DonateModal({ isOpen, onClose }) {
  const modalRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={modalRef}
        className="relative w-full bg-surface border border-black/10 dark:border-white/10 rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-200 max-w-3xl flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between p-3 border-b border-black/5 dark:border-white/5">
          <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-pink-500">volunteer_activism</span>
            Support Srouter
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          <p className="text-text-muted text-sm mb-6 text-center min-h-10 flex items-center justify-center">
            If Srouter helps your work, consider supporting development. Thank you! ❤️
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <DonateCard />
            <DonateCard telegram />
            <DonateCard />
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function DonateCard({ telegram = false }) {
  return (
    <div
      aria-hidden={telegram ? undefined : true}
      className="flex flex-col items-center p-4 rounded-xl border border-black/10 dark:border-white/10 bg-surface/50 hover:border-pink-500/40 transition-colors min-h-[390px] justify-center"
    >
      {telegram && (
        <>
          <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3 bg-sky-500/20 text-sky-500">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[26px]" fill="currentColor">
              <path d="M23.91 3.79 20.3 20.84c-.27 1.2-.98 1.5-1.98.94l-5.5-4.06-2.65 2.55c-.3.3-.55.55-1.13.55l.4-5.6L19.63 5.99c.44-.4-.1-.62-.68-.23L6.35 13.7.92 12c-1.18-.37-1.2-1.18.25-1.75L22.41 2.06c.98-.36 1.84.23 1.5 1.73Z" />
            </svg>
          </div>
          <a
            href="https://t.me/seezyes"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-text-main mb-3 hover:text-pink-500 transition-colors"
          >
            Tg t.me/seezyes
          </a>
          <Image
            src="/support/telegram-seezyes.png"
            alt="QR code for https://t.me/seezyes"
            width={180}
            height={180}
            unoptimized
            className="w-full max-w-[180px] aspect-square object-contain rounded-lg bg-white p-1"
          />
          <a
            href="https://t.me/seezyes"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-sky-500 hover:opacity-90 transition-opacity"
          >
            Open
            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">open_in_new</span>
          </a>
        </>
      )}
    </div>
  );
}

DonateModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
