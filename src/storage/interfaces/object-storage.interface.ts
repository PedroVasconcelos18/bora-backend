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
}
