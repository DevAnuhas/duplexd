'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useId, useState, type ComponentProps } from 'react';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';

/**
 * A password field you can read back.
 *
 * Typing a password blind is the single most common way people fail to sign
 * in, and the failure is invisible to them: the form says "email or password
 * is incorrect" whether they mistyped or genuinely forgot. Every password
 * input in this app gets this control.
 *
 * Three details are accessibility rather than decoration:
 *
 *  - The toggle is a real `<button type="button">`. A `<div>` with an
 *    onClick is unreachable by keyboard, and without `type="button"` it
 *    submits the form it sits in.
 *  - `aria-pressed` says the control is a toggle in a state, and the
 *    `aria-label` flips to describe the *action* rather than the state, so a
 *    screen reader announces "Show password, not pressed" and then "Hide
 *    password, pressed".
 *  - Revealing never changes focus or the caret. Swapping the `type` on the
 *    same element preserves both; replacing the element would not.
 *
 * The visibility state is deliberately per-field and local. A page-level
 * "reveal everything" would expose a password the customer only meant to
 * check one of, and it would persist across a failed submit.
 */
export function PasswordInput({
  id,
  ...props
}: Omit<ComponentProps<typeof InputGroupInput>, 'type'>) {
  const [visible, setVisible] = useState(false);
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  return (
    <InputGroup>
      <InputGroupInput
        {...props}
        id={inputId}
        /*
          44px, not the 36px default. The toggle sits inside this row, so the
          row's height is what gives the button a 44×44 target without it
          overflowing the group.
        */
        className="h-11"
        type={visible ? 'text' : 'password'}
        /*
          `current-password` and `new-password` are passed in by each form;
          this only guarantees the browser is told something, because a
          password field with no autocomplete hint gets a warning in some
          browsers and unhelpful behaviour in others.
        */
        autoComplete={props.autoComplete ?? 'current-password'}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          variant="ghost"
          className="size-11"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          aria-controls={inputId}
          onClick={() => setVisible((shown) => !shown)}
        >
          {visible ? (
            <EyeOff aria-hidden="true" />
          ) : (
            <Eye aria-hidden="true" />
          )}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
