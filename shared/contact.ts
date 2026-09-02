import { z } from 'zod';

/**
 * The contact form's contract, defined once and used on both sides.
 *
 * The client uses it to show a field-level error before a request is made; the
 * server uses it as the actual gate. Sharing the schema means the two cannot
 * disagree about what is valid — but the client half is a convenience only.
 * Client-side validation is a UX feature; the server's copy is the security
 * boundary, because anything the browser enforces can be skipped by not using
 * the browser.
 */
export const contactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Please enter your name.')
    .max(100, 'That name is longer than we can store.'),
  email: z
    .string()
    .trim()
    .min(1, 'Please enter your email address.')
    // Zod's email check is deliberately permissive, and so is this: rejecting
    // an address that turns out to be deliverable is worse than accepting one
    // that bounces. Real verification is a confirmation email, not a regex.
    .email('That does not look like an email address.')
    .max(254, 'That address is longer than an email address can be.'),
  subject: z
    .string()
    .trim()
    .min(1, 'Please enter a subject.')
    .max(150, 'Please shorten the subject.'),
  message: z
    .string()
    .trim()
    .min(10, 'Please write at least a sentence.')
    .max(5000, 'Please shorten your message.'),
  /**
   * Honeypot. Hidden from users, so anything in it came from something filling
   * every field it found. Cheaper and less hostile than a CAPTCHA, and it
   * catches the overwhelming majority of automated submissions.
   */
  website: z.string().max(0, 'Rejected.').optional(),
});

export type ContactSubmission = z.infer<typeof contactSchema>;

/** Field-level errors, keyed by field name, as the form renders them. */
export type ContactErrors = Partial<Record<keyof ContactSubmission, string>>;

/** Flatten a Zod failure into the shape the form component expects. */
export function toFieldErrors(error: z.ZodError): ContactErrors {
  const errors: ContactErrors = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && !(field in errors)) {
      // First error per field only: a list of three complaints about one input
      // is noise, and the first is the one to fix.
      errors[field as keyof ContactSubmission] = issue.message;
    }
  }
  return errors;
}
