/**
 * Compile-time rollout boundary. Each release commit advances this literal by
 * one so the previous commit remains a safe rollback target.
 */
export type DigitalDeliveryRelease = 1 | 2 | 3 | 4;

export const DIGITAL_DELIVERY_RELEASE: DigitalDeliveryRelease = 3;

export const lifecycleActive = (release: DigitalDeliveryRelease = DIGITAL_DELIVERY_RELEASE) =>
  release >= 2;
export const entitlementWriterActive = (release: DigitalDeliveryRelease = DIGITAL_DELIVERY_RELEASE) =>
  release >= 3;
export const attachmentActive = (release: DigitalDeliveryRelease = DIGITAL_DELIVERY_RELEASE) =>
  release >= 4;
