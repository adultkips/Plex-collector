import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BASE_DIR / '.env')

APP_NAME = 'Plex Collector'
APP_VERSION = '0.1.0'
HOST = os.getenv('HOST', '127.0.0.1')
PORT = int(os.getenv('PORT', '8787'))

PLEX_CLIENT_ID = os.getenv('PLEX_CLIENT_ID', 'plex-collector-local')
PLEX_PRODUCT = os.getenv('PLEX_PRODUCT', 'Plex Collector')
PLEX_VERSION = os.getenv('PLEX_VERSION', '0.1.0')
PLEX_PLATFORM = os.getenv('PLEX_PLATFORM', 'Web')
PLEX_DEVICE = os.getenv('PLEX_DEVICE', 'Localhost')

TMDB_API_KEY = os.getenv('TMDB_API_KEY', '')
TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500'

DB_PATH = BASE_DIR / 'backend' / 'data' / 'plex_collector.db'
STATIC_DIR = BASE_DIR / 'frontend' / 'static'
