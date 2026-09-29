"""
Motor 2 do BYTZ - pega o produto novo na planilha, atualiza o cookie de sessao no ML e gera o link de afiliado. Migrado do n8n pra Python.

Regras que NAO pode quebrar:
1. variavel se chama url_original (no n8n tinha um bug de typo + "==" que sujava a url, aqui a variavel vem limpa)
2. so processa 1 produto por vez (LIMIT 1), nao processa a lista toda
3. merge_cookie é sagrado, não simplifica essa logica por nada
4. pra saber se deu erro, olha o status que vem DENTRO do body da resposta, não só o status http
"""

import os
import smtplib
from datetime import datetime
from email.mime.text import MIMEText
from zoneinfo import ZoneInfo

import gspread
import requests
from google.oauth2.service_account import Credentials

from dotenv import load_dotenv
load_dotenv()

# configs gerais do projeto
SPREADSHEET_ID = "1Hi9nUqZMmp-lMf1-9isdEmXRdRSWVrQ3pCD-LiAvt3E"
AFFILIATE_TAG = "amvi359443"

ML_LINKBUILDER_URL = "https://www.mercadolivre.com.br/afiliados/linkbuilder"
ML_CREATE_LINK_URL = "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink"

SHEET_PRODUTOS = "Produtos"
SHEET_WEBSCRAPING = "WebScraping"

# finge que é um chrome de verdade, senao o ML bloqueia
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
)

TZ_SAO_PAULO = ZoneInfo("America/Sao_Paulo")

# conecta no google sheets usando a service account
def get_sheets_client() -> gspread.Client:
    creds_path = os.environ["GOOGLE_SERVICE_ACCOUNT_FILE"]
    creds = Credentials.from_service_account_file(
        creds_path,
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return gspread.authorize(creds)

# pega o primeiro produto com status Novo na aba Produtos (so 1, nunca a lista toda)
def get_produto_novo(client: gspread.Client) -> dict | None:
    sh = client.open_by_key(SPREADSHEET_ID)
    ws = sh.worksheet(SHEET_PRODUTOS)
    registros = ws.get_all_records()

    novos = [r for r in registros if r.get("status") == "Novo"]
    if not novos:
        return None

    return novos[0]  # limit 1 aqui

if __name__ == "__main__":
    pass