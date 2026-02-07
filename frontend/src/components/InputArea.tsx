import { useState, useRef, useEffect, useCallback } from 'react';
import type React from 'react';
import type { PendingImage } from '../types';

interface InputAreaProps {
  selectedId: string;
  onSend: (
    text: string,
    images: { name: string; base64: string; mimeType: string }[],
  ) => void;
  onCancel: () => void;
}

export function InputArea({
  selectedId,
  onSend,
  onCancel,
}: InputAreaProps): React.ReactElement {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);

  // Reset state and focus input when session changes
  useEffect(() => {
    setText('');
    setImages([]);
    // Small delay to ensure DOM is ready after session switch
    setTimeout(() => textInputRef.current?.focus(), 100);
  }, [selectedId]);

  // VisualViewport: keep input above mobile keyboard
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    function handleViewport() {
      const el = inputAreaRef.current;
      if (!el || !window.visualViewport) return;
      const offset = window.innerHeight - window.visualViewport.height;
      el.style.bottom = offset + 'px';
    }

    vv.addEventListener('resize', handleViewport);
    vv.addEventListener('scroll', handleViewport);
    return () => {
      vv.removeEventListener('resize', handleViewport);
      vv.removeEventListener('scroll', handleViewport);
    };
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    onSend(
      trimmed,
      images.map((img) => ({
        name: img.name,
        base64: img.base64,
        mimeType: img.mimeType,
      })),
    );
    setText('');
    setImages([]);
  }, [text, images, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      files.forEach((file) => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string;
          setImages((prev) => [
            ...prev,
            {
              name: file.name,
              dataUrl,
              base64: dataUrl.split(',')[1],
              mimeType: file.type,
            },
          ]);
        };
        reader.readAsDataURL(file);
      });
      // Reset input so same file can be re-selected
      e.target.value = '';
    },
    [],
  );

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  return (
    <div id="input-area" className="visible" ref={inputAreaRef}>
      {images.length > 0 && (
        <div id="img-preview" className="visible">
          {images.map((img, i) => (
            <div className="img-thumb-wrap" key={i}>
              <img src={img.dataUrl} alt={img.name} />
              <button className="img-x" onClick={() => removeImage(i)}>
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      <div id="input-row">
        <button
          className="btn-attach"
          title="Attach image"
          onClick={() => fileInputRef.current?.click()}
        >
          {'\uD83D\uDCCE'}
        </button>
        <input
          type="text"
          ref={textInputRef}
          placeholder="Send a message..."
          enterKeyHint="send"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <input
          type="file"
          accept="image/*"
          multiple
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button className="btn-send" onClick={handleSend}>
          Send
        </button>
        <button className="btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
