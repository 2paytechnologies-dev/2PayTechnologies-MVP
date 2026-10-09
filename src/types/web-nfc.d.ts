/** Minimal Web NFC typings (Chrome for Android). Not part of lib.dom. */
interface NDEFRecordInit {
  recordType: string;
  data?: string | BufferSource;
  mediaType?: string;
}
interface NDEFMessageInit {
  records: NDEFRecordInit[];
}
interface NDEFWriteOptions {
  overwrite?: boolean;
  signal?: AbortSignal;
}
declare class NDEFReader {
  constructor();
  write(message: string | NDEFMessageInit, options?: NDEFWriteOptions): Promise<void>;
}
