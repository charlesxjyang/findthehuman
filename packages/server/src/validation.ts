// Only allow standard QWERTY characters, numbers, and basic punctuation
const ALLOWED_PATTERN = /^[a-zA-Z0-9 \n\r\t.,!?;:'"()\-–—\/\\@#$%&*+=\[\]{}<>~`^_|]+$/;

export function validateMessageContent(content: string): string | null {
  if (!content || typeof content !== 'string') {
    return 'content is required';
  }

  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return 'Message cannot be empty';
  }

  if (trimmed.length > 500) {
    return 'Message too long (max 500 chars)';
  }

  if (!ALLOWED_PATTERN.test(trimmed)) {
    return 'Message contains unsupported characters. Only English letters, numbers, and standard punctuation are allowed.';
  }

  return null; // valid
}
