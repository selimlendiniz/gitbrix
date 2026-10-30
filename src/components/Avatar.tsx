// An author's picture, or their initials on a colour picked from the
// address (the same person gets the same colour everywhere).

import { useAvatar } from "../avatars";
import { LANE_COLORS } from "../colors";
import { initials } from "../format";

export function personColor(key: string): string {
  let h = 0;
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return LANE_COLORS[Math.abs(h) % LANE_COLORS.length];
}

export function Avatar({ email, name, size = 18, title }: { email?: string | null; name: string; size?: number; title?: string }) {
  const pic = useAvatar(email);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (pic) return <img className="avatar" src={pic} alt="" style={style} title={title} draggable={false} />;
  return (
    <span className="avatar initials" style={{ ...style, background: personColor(email || name) }} title={title} aria-hidden>
      {initials(name)}
    </span>
  );
}
