<?php

declare(strict_types=1);

namespace Drupal\nuxt_contact\Controller;

use Drupal\Component\Utility\EmailValidatorInterface;
use Drupal\contact\MessageInterface;
use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Flood\FloodInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * Accepts a contact submission from the decoupled front end.
 *
 * The alternative is turning JSON:API's `read_only` off so the front end can
 * POST a `contact_message`. That flag is global: switching it off to accept a
 * contact form opens the write surface of every entity type the requester can
 * touch, and — because the front end is a public origin — opens it to anyone
 * who finds the endpoint, bypassing the validation, honeypot and rate limit
 * that live in the Nuxt route.
 *
 * So JSON:API stays read-only and this endpoint exists instead. It creates
 * exactly one entity type, and nothing about it generalises to a second.
 *
 * Two defences that belong on this side rather than in the front end:
 *
 * - **Flood control.** Drupal's own service, shared with the core contact form,
 *   so the limit applies however the message arrived. The front end's rate
 *   limiter is per-instance and in-memory; this one is not.
 * - **Validation through the entity API.** The message is validated as a Drupal
 *   entity before saving, so field constraints configured in the CMS are
 *   enforced — not only the ones the front end's schema happens to know about.
 */
final class ContactSubmitController extends ControllerBase {

  /** Submissions allowed per window, matching core's contact form default. */
  private const LIMIT = 5;

  /** Flood window, in seconds. */
  private const WINDOW = 3600;

  public function __construct(
    private readonly FloodInterface $flood,
    private readonly EmailValidatorInterface $emailValidator,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self(
      $container->get('flood'),
      $container->get('email.validator'),
    );
  }

  /**
   * Create and send a contact message.
   */
  public function submit(Request $request): JsonResponse {
    if (!$this->flood->isAllowed('nuxt_contact.submit', self::LIMIT, self::WINDOW)) {
      return new JsonResponse(
        ['error' => 'Too many submissions. Please try again later.'],
        429,
      );
    }

    $payload = json_decode((string) $request->getContent(), TRUE);
    if (!is_array($payload)) {
      return new JsonResponse(['error' => 'Body is not JSON.'], 400);
    }

    $name = trim((string) ($payload['name'] ?? ''));
    $mail = trim((string) ($payload['mail'] ?? ''));
    $subject = trim((string) ($payload['subject'] ?? ''));
    $message = trim((string) ($payload['message'] ?? ''));

    if ($name === '' || $subject === '' || $message === '') {
      return new JsonResponse(['error' => 'Missing required fields.'], 422);
    }

    // Re-validated here rather than trusted from the front end: this endpoint
    // is reachable independently of it, and the address is used as a
    // Reply-To — an unvalidated one is a header-injection surface.
    if (!$this->emailValidator->isValid($mail)) {
      return new JsonResponse(['error' => 'Invalid email address.'], 422);
    }

    $form = $this->contactFormId();
    if ($form === NULL) {
      return new JsonResponse(['error' => 'No contact form is configured.'], 503);
    }

    /** @var \Drupal\contact\MessageInterface $entity */
    $entity = $this->entityTypeManager()->getStorage('contact_message')->create([
      'contact_form' => $form,
      'name' => $name,
      'mail' => $mail,
      'subject' => $subject,
      'message' => $message,
    ]);

    $violations = $entity->validate();
    if ($violations->count() > 0) {
      // Field constraints configured in the CMS are enforced here, not only the
      // ones the front end's schema happens to know about.
      return new JsonResponse([
        'error' => 'Validation failed.',
        'details' => array_map(
          static fn($v) => (string) $v->getMessage(),
          iterator_to_array($violations),
        ),
      ], 422);
    }

    // Note that this does not persist anything. Core gives `contact_message`
    // no storage table: messages are sent, not kept, and adding persistence is
    // what the `contact_storage` contrib module is for. The save call runs the
    // entity's presave hooks, which some modules rely on; delivery is the mail
    // handler below.
    $entity->save();

    // Registered after validation passes, so a rejected submission does not
    // consume a legitimate sender's quota.
    $this->flood->register('nuxt_contact.submit', self::WINDOW);

    if ($entity instanceof MessageInterface) {
      // Core's own mail handler, so the contact form's configured recipients,
      // subject prefix and templates all apply. Reimplementing delivery here
      // would drift from the CMS's configuration the first time an editor
      // changed it.
      \Drupal::service('contact.mail_handler')->sendMailMessages(
        $entity,
        $this->currentUser(),
      );
    }

    return new JsonResponse(['ok' => TRUE], 201);
  }

  /**
   * The contact form to file messages against.
   *
   * Prefers the site's configured default, so an editor changing it in the UI
   * changes where these messages land — rather than the id being frozen in
   * code.
   */
  private function contactFormId(): ?string {
    $default = (string) $this->config('contact.settings')->get('default_form');
    $storage = $this->entityTypeManager()->getStorage('contact_form');

    if ($default !== '' && $storage->load($default) !== NULL) {
      return $default;
    }

    foreach ($storage->loadMultiple() as $id => $_form) {
      // `personal` is the user-to-user form and has no site-wide recipients.
      if ($id !== 'personal') {
        return (string) $id;
      }
    }

    return NULL;
  }

}
