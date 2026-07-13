import { S3Client } from "@aws-sdk/client-s3";
import { FileRawObjectStore, S3RawObjectStore, type RawObjectStore } from "../packages/storage/src/object-store.js";

export function createObjectStore(): RawObjectStore {
  const bucket = process.env.S3_BUCKET;
  if (bucket === undefined || bucket === "") return new FileRawObjectStore(process.env.RAW_STORAGE_PATH ?? ".data");
  const endpoint = process.env.S3_ENDPOINT;
  return new S3RawObjectStore(new S3Client({
    region: process.env.S3_REGION ?? "ap-southeast-1",
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint, forcePathStyle: true }),
  }), bucket);
}

