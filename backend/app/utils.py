import re
import unicodedata


def normalize_title(title: str) -> str:
    text = unicodedata.normalize('NFKD', title).encode('ascii', 'ignore').decode('ascii')
    text = text.lower()
    text = re.sub(r'[^a-z0-9]+', ' ', text).strip()
    return re.sub(r'\s+', ' ', text)


def actor_id_from_name(name: str) -> str:
    return normalize_title(name).replace(' ', '-')
