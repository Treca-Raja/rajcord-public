import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X, Download } from 'lucide-react';
import type { ChatImageAttachment } from '@tricord/shared';
import { chatImageUrl } from './chat-images';

function ImageViewer({
  src,
  filename,
  trigger,
  close,
  failed,
}: {
  src: string;
  filename: string;
  trigger: RefObject<HTMLButtonElement | null>;
  close: () => void;
  failed: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const current = dialog.current!;
    current.showModal();
    const previous = trigger.current;
    return () => {
      current.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [trigger]);
  return createPortal(
    <dialog
      ref={dialog}
      className="chat-image-viewer"
      role="dialog"
      aria-label="Image preview"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="chat-image-viewer-content">
        <header>
          <a href={src + '?download=1'} download={filename}>
            <Download size={16} aria-hidden="true" />
            Download image
          </a>
          <button type="button" aria-label="Close image preview" onClick={close}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <img src={src} alt="Shared image" onError={failed} />
      </div>
    </dialog>,
    document.body,
  );
}

export function ChatImage({
  conversationId,
  messageId,
  attachment,
}: {
  conversationId: string;
  messageId: string;
  attachment: ChatImageAttachment;
}) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const src = chatImageUrl(conversationId, messageId);
  const extension = attachment.mimeType === 'image/jpeg' ? 'jpg' : attachment.mimeType.slice(6);
  const filename = 'rajcord-image.' + extension;
  if (failed)
    return (
      <div className="chat-image-unavailable" role="alert">
        Image unavailable. It may have been removed or access changed.
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setFailed(false);
          }}
        >
          Retry image
        </button>
      </div>
    );
  return (
    <figure className="chat-image">
      <button
        ref={trigger}
        type="button"
        className="chat-image-open"
        aria-label="Open image"
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt="Shared image"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </button>
      <figcaption>
        <a href={src + '?download=1'} download={filename}>
          <Download size={13} aria-hidden="true" />
          Download image
        </a>
        <span>
          {extension.toUpperCase()} · {Math.max(1, Math.ceil(attachment.size / 1024))} KiB
        </span>
      </figcaption>
      {open && (
        <ImageViewer
          src={src}
          filename={filename}
          trigger={trigger}
          close={() => setOpen(false)}
          failed={() => setFailed(true)}
        />
      )}
    </figure>
  );
}
