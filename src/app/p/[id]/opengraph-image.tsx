import { CARD_ALT, CARD_CONTENT_TYPE, CARD_SIZE } from "@/server/og/document-card";
import { documentCardImage } from "@/server/og/document-card-route";

// The per-document social card for a view link (`/d/<id>` sends anonymous visitors here, so this is the
// image Slack renders for a shared document), see src/server/og/document-card.tsx. Rendered per request.
export const dynamic = "force-dynamic";
export const alt = CARD_ALT;
export const size = CARD_SIZE;
export const contentType = CARD_CONTENT_TYPE;

export default documentCardImage;
