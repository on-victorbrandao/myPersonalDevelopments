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

# pega o cookie salvo na aba WebScraping (é sempre a mesma linha fixa). se não achar a linha ou vier vazio, para tudo e explica o motivo em vez de seguir com cookie em branco
def get_cookie_atual(client: gspread.Client) -> tuple[str, gspread.Worksheet, int]:
    sh = client.open_by_key(SPREADSHEET_ID)
    ws = sh.worksheet(SHEET_WEBSCRAPING)
    registros = ws.get_all_records()

    for idx, registro in enumerate(registros):
        if (
            registro.get("categoria") == "/afiliados/linkbuilder"
            and registro.get("sub_categoria") == "/cabecalhos/solicitacao/cookie"
        ):
            cookie = str(registro.get("id_cookie", "")).strip()
            if not cookie:
                raise RuntimeError("A linha de cookie existe, mas id_cookie está vazio.")

            linha_real = idx + 2  # +1 do cabecalho, +1 porque sheets comeca em 1
            return cookie, ws, linha_real

    raise RuntimeError("Não encontrei a linha do linkbuilder na aba WebScraping.")

# grava o cookie novo de volta na planilha, com data e hora
def update_cookie_na_planilha(ws: gspread.Worksheet, linha: int, cookies_atualizados: str) -> None:
    header = ws.row_values(1)
    col_cookie = header.index("id_cookie") + 1
    ws.update_cell(linha, col_cookie, cookies_atualizados)

    if "data_hora_inclusao" in header:
        col_data = header.index("data_hora_inclusao") + 1
        agora = datetime.now(TZ_SAO_PAULO).strftime("%d/%m/%Y %H:%M:%S")
        ws.update_cell(linha, col_data, agora)

# funcao abaixo é a parte mais sensivel do projeto, NAO MEXER sem necessidade. junta o cookie antigo com os cookies novos que vieram no set-cookie da resposta, o novo sempre sobrescreve o antigo se a chave repetir, e no final tira o _csrf pra mandar no header depois. é a copia fiel do que rodava no n8n
def merge_cookie(old_cookie_string: str, set_cookie_headers: list[str]) -> dict:
    cookie_map: dict[str, str] = {}

    if old_cookie_string:
        for parte in old_cookie_string.split(";"):
            parte = parte.strip()
            if "=" in parte:
                chave, _, valor = parte.partition("=")
                cookie_map[chave.strip()] = valor

    for bruto in set_cookie_headers or []:
        cookie_parte = bruto.split(";")[0].strip()
        if "=" in cookie_parte:
            chave, _, valor = cookie_parte.partition("=")
            cookie_map[chave.strip()] = valor

    novo_cookie_string = "; ".join(f"{chave}={valor}" for chave, valor in cookie_map.items())
    csrf_token = cookie_map.get("_csrf", "")

    return {
        "cookies_atualizados": novo_cookie_string,
        "csrf_token": csrf_token,
    }

# faz um GET na pagina do linkbuilder só pra capturar os cookies novos que o ML devolve. se o GET não vier 200, para na hora, pois não faz sentido seguir com cookie desatualizado
def get_set_cookies(cookie_atual: str) -> list[str]:
    resposta = requests.get(
        ML_LINKBUILDER_URL,
        headers={"cookie": cookie_atual},
        timeout=15,
    )

    if resposta.status_code != 200:
        raise RuntimeError(
            f"GET do linkbuilder falhou: HTTP {resposta.status_code}. Não vou atualizar o cookie nem gerar o link."
        )

    # o requests normal junta todos os set-cookie em uma string só, e isso quebra a logica, por isso pega direto do raw pra manter cada cookie separado
    headers = resposta.raw.headers
    if not hasattr(headers, "getlist"):
        raise RuntimeError("Não consegui ler os cabeçalhos Set-Cookie separadamente.")

    return headers.getlist("Set-Cookie")

if __name__ == "__main__":
    pass