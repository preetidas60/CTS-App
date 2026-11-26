import {
  useEffect,
  useRef,
  useState,
} from "react";

import type { ConfidenceLevel } from "../../types";
import ChequeViewer from "./ChequeViewer";
import AccountFields from "./AccountFields";

interface ChequeAreaProps {
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  initialOcrValue: string;

  /**
   * Optional override for the cheque image.
   */
  initialImageSrc?: string;

  /**
   * Persists the confirmed account number.
   * Threaded straight to AccountFields.
   */
  onSubmitAccountNumber?: (
    value: string,
  ) => Promise<unknown>;
}

/**
 * Fallback image used when no cheque image is supplied.
 *
 * This is intentionally an inline SVG data URL so that
 * the component does not depend on a local PNG asset.
 */
const FALLBACK_CHEQUE_IMAGE =
  "data:image/svg+xml;charset=UTF-8," +
  encodeURIComponent(`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="900"
      height="450"
      viewBox="0 0 900 450"
    >
      <rect
        width="900"
        height="450"
        rx="18"
        fill="#f7f8fa"
      />

      <rect
        x="25"
        y="25"
        width="850"
        height="400"
        rx="12"
        fill="#ffffff"
        stroke="#d9dde3"
        stroke-width="2"
      />

      <text
        x="60"
        y="85"
        font-family="Arial, Helvetica, sans-serif"
        font-size="28"
        font-weight="700"
        fill="#1f2937"
      >
        HDFC BANK
      </text>

      <text
        x="60"
        y="125"
        font-family="Arial, Helvetica, sans-serif"
        font-size="14"
        fill="#6b7280"
      >
        CTS CHEQUE
      </text>

      <line
        x1="60"
        y1="155"
        x2="840"
        y2="155"
        stroke="#e5e7eb"
        stroke-width="2"
      />

      <text
        x="60"
        y="205"
        font-family="Arial, Helvetica, sans-serif"
        font-size="14"
        fill="#9ca3af"
      >
        Cheque image preview
      </text>

      <rect
        x="60"
        y="225"
        width="780"
        height="90"
        rx="8"
        fill="#f9fafb"
        stroke="#e5e7eb"
      />

      <text
        x="450"
        y="280"
        text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif"
        font-size="16"
        fill="#9ca3af"
      >
        Upload a cheque image to preview it here
      </text>

      <text
        x="60"
        y="365"
        font-family="monospace"
        font-size="18"
        fill="#374151"
      >
        |||||||||||||||||||||||||||||||||||||||
      </text>
    </svg>
  `);

export default function ChequeArea({
  confidence,
  confidenceLevel,
  initialOcrValue,
  initialImageSrc,
  onSubmitAccountNumber,
}: ChequeAreaProps) {
  const [imageSrc, setImageSrc] = useState<string>(
    initialImageSrc ?? FALLBACK_CHEQUE_IMAGE,
  );

  const uploadInputRef =
    useRef<HTMLInputElement | null>(null);

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const handleFileChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];

    if (!file) {
      return;
    }

    const url = URL.createObjectURL(file);

    setImageSrc((previousUrl) => {
      if (
        previousUrl &&
        previousUrl.startsWith("blob:")
      ) {
        URL.revokeObjectURL(previousUrl);
      }

      return url;
    });
  };

  useEffect(() => {
    return () => {
      if (
        imageSrc &&
        imageSrc.startsWith("blob:")
      ) {
        URL.revokeObjectURL(imageSrc);
      }
    };
  }, [imageSrc]);

  useEffect(() => {
    if (initialImageSrc) {
      setImageSrc(initialImageSrc);
    }
  }, [initialImageSrc]);

  return (
    <div className="cheque-area">
      <ChequeViewer imageSrc={imageSrc} />

      <AccountFields
        confidence={confidence}
        confidenceLevel={confidenceLevel}
        initialOcrValue={initialOcrValue}
        onUploadClick={handleUploadClick}
        onSubmitAccountNumber={
          onSubmitAccountNumber
        }
      />

      <input
        type="file"
        id="uploadImageInput"
        accept="image/*"
        hidden
        ref={uploadInputRef}
        onChange={handleFileChange}
      />
    </div>
  );
}