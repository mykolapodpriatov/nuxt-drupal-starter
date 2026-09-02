<script setup lang="ts">
import { contactSchema, toFieldErrors } from '#shared/contact';
import type { ContactErrors, ContactSubmission } from '#shared/contact';

/**
 * Contact form.
 *
 * Posts to this app's own server route, never to Drupal. A direct write would
 * mean shipping a credential that can create content to every visitor.
 *
 * The validation here is a convenience — immediate feedback without a round
 * trip. The server runs the same schema, and that copy is the actual gate;
 * anything enforced only in the browser can be skipped by not using one.
 */
const form = reactive<ContactSubmission>({
  name: '',
  email: '',
  subject: '',
  message: '',
  website: '',
});

const errors = ref<ContactErrors>({});
const status = ref<'idle' | 'sending' | 'sent' | 'failed'>('idle');
const failureMessage = ref('');

/**
 * Focus the first invalid field after a failed submit.
 *
 * Without it a keyboard or screen-reader user is told the form failed and left
 * at the submit button, with no indication of where the problem is.
 */
const formEl = ref<HTMLFormElement | null>(null);

async function focusFirstError(): Promise<void> {
  await nextTick();
  const firstInvalid = formEl.value?.querySelector<HTMLElement>('[aria-invalid="true"]');
  firstInvalid?.focus();
}

async function submit(): Promise<void> {
  errors.value = {};
  failureMessage.value = '';

  const parsed = contactSchema.safeParse(form);
  if (!parsed.success) {
    errors.value = toFieldErrors(parsed.error);
    status.value = 'idle';
    await focusFirstError();
    return;
  }

  status.value = 'sending';

  try {
    await $fetch('/api/contact', { method: 'POST', body: parsed.data });
    status.value = 'sent';
  } catch (error: unknown) {
    const response = error as {
      statusCode?: number;
      statusMessage?: string;
      data?: { data?: { errors?: ContactErrors } };
    };

    // The server returns field errors for a 422; anything else is a problem
    // the visitor cannot fix by editing an input.
    const fieldErrors = response.data?.data?.errors;
    if (response.statusCode === 422 && fieldErrors) {
      errors.value = fieldErrors;
      status.value = 'idle';
      await focusFirstError();
      return;
    }

    status.value = 'failed';
    failureMessage.value =
      response.statusMessage ?? 'Something went wrong. Please try again.';
  }
}

useHead({ title: 'Contact' });
</script>

<template>
  <div>
    <h1>Contact</h1>

    <!-- `role="status"` and `aria-live` so the outcome is announced rather
         than merely rendered. A sighted user sees the message appear; without
         this a screen-reader user gets nothing at all. -->
    <p v-if="status === 'sent'" class="notice notice--ok" role="status">
      Thank you — your message has been sent.
    </p>

    <p v-else-if="status === 'failed'" class="notice notice--error" role="alert">
      {{ failureMessage }}
    </p>

    <form v-if="status !== 'sent'" ref="formEl" novalidate @submit.prevent="submit">
      <div class="field">
        <label for="name">Name</label>
        <input
          id="name"
          v-model="form.name"
          type="text"
          autocomplete="name"
          :aria-invalid="Boolean(errors.name)"
          :aria-describedby="errors.name ? 'name-error' : undefined"
        >
        <!-- The error is tied to the input by `aria-describedby`, so it is read
             out with the field rather than being a stray line of red text. -->
        <p v-if="errors.name" id="name-error" class="field__error">{{ errors.name }}</p>
      </div>

      <div class="field">
        <label for="email">Email</label>
        <input
          id="email"
          v-model="form.email"
          type="email"
          autocomplete="email"
          :aria-invalid="Boolean(errors.email)"
          :aria-describedby="errors.email ? 'email-error' : undefined"
        >
        <p v-if="errors.email" id="email-error" class="field__error">{{ errors.email }}</p>
      </div>

      <div class="field">
        <label for="subject">Subject</label>
        <input
          id="subject"
          v-model="form.subject"
          type="text"
          :aria-invalid="Boolean(errors.subject)"
          :aria-describedby="errors.subject ? 'subject-error' : undefined"
        >
        <p v-if="errors.subject" id="subject-error" class="field__error">
          {{ errors.subject }}
        </p>
      </div>

      <div class="field">
        <label for="message">Message</label>
        <textarea
          id="message"
          v-model="form.message"
          rows="6"
          :aria-invalid="Boolean(errors.message)"
          :aria-describedby="errors.message ? 'message-error' : undefined"
        />
        <p v-if="errors.message" id="message-error" class="field__error">
          {{ errors.message }}
        </p>
      </div>

      <!--
        Honeypot. Hidden with a class rather than `display: none` or
        `type="hidden"`: both of those are trivially detected by a bot, while a
        visually-hidden text input looks like an ordinary field to something
        parsing the DOM. `aria-hidden` and `tabindex="-1"` keep it away from
        assistive technology and the tab order, so no human ever encounters it.
      -->
      <div class="honeypot" aria-hidden="true">
        <label for="website">Website</label>
        <input id="website" v-model="form.website" type="text" tabindex="-1" autocomplete="off">
      </div>

      <button type="submit" :disabled="status === 'sending'">
        {{ status === 'sending' ? 'Sending…' : 'Send message' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
h1 {
  margin-top: 0;
}

.field {
  margin-bottom: 1.25rem;
}

.field label {
  display: block;
  margin-bottom: 0.35rem;
  font-weight: 500;
}

.field input,
.field textarea {
  width: 100%;
  padding: 0.55rem 0.7rem;
  font: inherit;
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--rule);
  border-radius: 4px;
}

/* Driven by the ARIA attribute, so the visual state and the accessible state
   cannot drift apart — and the error is never signalled by colour alone,
   because the message beside it says the same thing. */
.field [aria-invalid='true'] {
  border-color: #c0392b;
}

.field__error {
  margin: 0.35rem 0 0;
  color: #c0392b;
  font-size: 0.88rem;
}

.honeypot {
  position: absolute;
  left: -9999px;
  width: 1px;
  height: 1px;
  overflow: hidden;
}

button {
  padding: 0.6rem 1.4rem;
  font: inherit;
  color: #fff;
  background: var(--accent);
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}

button:disabled {
  cursor: progress;
  opacity: 0.7;
}

.notice {
  padding: 0.75rem 1rem;
  margin-bottom: 1.5rem;
  border-left: 3px solid;
}

.notice--ok {
  border-color: #1e8449;
  background: color-mix(in srgb, #1e8449 10%, transparent);
}

.notice--error {
  border-color: #c0392b;
  background: color-mix(in srgb, #c0392b 10%, transparent);
}
</style>
