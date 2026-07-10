export interface GetUploadUrlParams {
  bucket?: string;
  key: string;
  contentType: string;
}

export interface UploadUrlResult {
  uploadUrl: string;
  objectKey: string;
  expiresAt: Date;
}

export interface IObjectStorage {
  getUploadUrl(params: GetUploadUrlParams): Promise<UploadUrlResult>;

  /**
   * Optional: the public read URL for a stored object. Implemented by read
   * models that expose objects publicly (the local V1 store and an R2 public
   * bucket). Optional so an adapter that uses per-request presigned GETs — or
   * the intact R2Adapter which does not change for this V1 pivot — can omit it
   * without breaking the interface contract.
   */
  getPublicUrl?(key: string): string;
}
