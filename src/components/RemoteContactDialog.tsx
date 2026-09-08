import { useEffect, useState, type FormEvent } from "react";
import { normalizeRemoteSourceUrl } from "../state/remoteContact";

export interface RemoteContactDialogValue {
  datasetUrl: string;
  bearerToken?: string;
}

interface RemoteContactDialogProps {
  open: boolean;
  onClose: () => void;
  onConnect: (value: RemoteContactDialogValue) => Promise<void>;
}

export function RemoteContactDialog({ open, onClose, onConnect }: RemoteContactDialogProps) {
  const [datasetUrl, setDatasetUrl] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!open) {
      setError(null);
      setConnecting(false);
      setBearerToken("");
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !connecting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [connecting, onClose, open]);

  if (!open) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const normalizedDatasetUrl = normalizeRemoteSourceUrl(datasetUrl);
      setDatasetUrl(normalizedDatasetUrl);
      await onConnect({
        datasetUrl: normalizedDatasetUrl,
        ...(bearerToken.trim() ? { bearerToken } : {}),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div
      className="assembly-delete-backdrop remote-contact-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !connecting) onClose();
      }}
    >
      <form
        className="remote-contact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-contact-title"
        onSubmit={(event) => { void submit(event); }}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="remote-contact-title">Open remote data</h2>
          <p>
            Paste a project-directory URL, a supported file URL, or a C-Studio data-service URL.
            You may omit http://. Static files are downloaded to the local application cache before
            opening.
          </p>
        </header>
        <label>
          <span>Remote URL</span>
          <input
            type="text"
            inputMode="url"
            required
            autoFocus
            spellCheck={false}
            placeholder="localhost:2222/ or host.example/project/input.mcool"
            value={datasetUrl}
            onChange={(event) => setDatasetUrl(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Bearer token <small>(optional)</small></span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={bearerToken}
            onChange={(event) => setBearerToken(event.currentTarget.value)}
          />
        </label>
        {error ? <p className="remote-contact-error" role="alert">{error}</p> : null}
        <footer>
          <button type="button" disabled={connecting} onClick={onClose}>Cancel</button>
          <button className="remote-contact-confirm" type="submit" disabled={connecting}>
            {connecting ? "Opening…" : "Open"}
          </button>
        </footer>
      </form>
    </div>
  );
}
