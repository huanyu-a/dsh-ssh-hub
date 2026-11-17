/**
 * Turning the tunnel editor's form into a patch.
 *
 * The subtle part is inherited values. A row displays `forwards.conf`'s name
 * when the tunnel record has none, and the editor pre-fills whatever the row
 * shows. Sending that value straight back would turn a fallback into a
 * decision: from then on the record owns the name and editing `forwards.conf`
 * stops having any effect on a tunnel the operator never meant to take over.
 *
 * So an inherited field that was left untouched is submitted as the empty
 * string — the same value the operator would get by clearing it by hand, which
 * both halves already treat as "keep inheriting". A field that was actually
 * changed is submitted as typed.
 */
import type { TunnelInfo } from '../../protocol.ts'

/** The editable text fields. */
export interface TunnelFormText {
  name: string
  description: string
}

/** The text half of a tunnel patch. */
export interface TunnelTextPatch {
  name: string
  description: string
}

/** Whether a field is still showing the value it inherited, untouched. */
function unchanged(inherited: boolean | undefined, current: string | undefined, typed: string): boolean {
  return inherited === true && typed.trim() === (current ?? '')
}

/**
 * The name/description to submit for `tunnel` given the form's current text.
 *
 * Clearing a field by hand and leaving an inherited field alone are the same
 * thing on purpose: both mean "no opinion of mine", and collapsing them means
 * the dialog needs no extra state to tell them apart.
 */
export function tunnelTextPatch(tunnel: TunnelInfo, form: TunnelFormText): TunnelTextPatch {
  return {
    name: unchanged(tunnel.nameInherited, tunnel.name, form.name) ? '' : form.name.trim(),
    description: unchanged(tunnel.descriptionInherited, tunnel.description, form.description)
      ? ''
      : form.description.trim(),
  }
}
