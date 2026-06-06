#!/usr/bin/env python3
"""Generate data/sectors.json from Upstox NSE instruments master.

Why
---
The swing-trade tab's sector discovery panel reads ``data/sectors.json`` —
a flat mapping of sector → list of ``{sym, isin, name}``. Hand-typing
ISINs is error-prone: one wrong digit silently drops a stock from the
panel because the ``/v2/market-quote/quotes`` endpoint returns null
for an unknown instrument key. This script does the heavy lifting:

  1. Downloads Upstox's free public NSE + BSE instruments masters.
  2. Filters to cash-equity rows (segment=NSE_EQ/BSE_EQ, instrument_type=EQ).
  3. Joins against a curated dict of "good companies per sector" so
     only liquid large/mid/quality-small caps make it into the file.
  4. Writes ``data/sectors.json`` with verified ISIN + tidied names, and
     ``data/instruments-index.json`` as a flat NSE + BSE-only lookup
     (dual-listed names dedupe to NSE; BSE-only rows carry an exch flag).

Re-run after a corporate rebrand (e.g. Zomato → Eternal, WABCOINDIA →
ZF Commercial Vehicle Control Systems) or whenever NSE adds/removes a
Nifty 500 constituent worth showing. Symbols not found in the master
are printed to stderr at the end so stale entries are obvious.

Run
---
    .venv/bin/python scripts/tools/generate-sectors.py

Or with system Python — only stdlib is used::

    python3 scripts/tools/generate-sectors.py
"""

from __future__ import annotations

import gzip
import io
import json
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Final, Mapping
from urllib.parse import quote


# Public Upstox instruments masters. Refreshed daily, no auth required.
NSE_MASTER_URL: Final[str] = (
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
)
# BSE master is pulled so the flat instruments-index can also surface
# BSE-only equities (names that never list on NSE). Dual-listed names are
# deduped by ISIN with NSE winning — see emit_instruments_index().
BSE_MASTER_URL: Final[str] = (
    "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz"
)

# Upstox V2 LTP endpoint — used to attach a last-traded-price snapshot to
# every stock so the swing tab's sector cards can show how many names fall
# inside the tradeable price band (data/config.json → swing_price_band)
# WITHOUT a per-card network round trip. The V2 endpoint caps a single
# request at 500 instrument keys (confirmed against the Upstox docs). We
# mirror the app's own V2 usage (Bearer token from data/config.json). The
# price is a SNAPSHOT — re-run this script to refresh it. Off-hours the
# `last_price` Upstox returns equals the previous session's close, which is
# exactly the figure a band-membership count needs.
UPSTOX_LTP_URL: Final[str] = "https://api.upstox.com/v2/market-quote/ltp"
LTP_BATCH: Final[int] = 500

# Cloudflare in front of Upstox 1010-bans urllib's default User-Agent (the
# same reason download_master spoofs a browser UA). Without this, every LTP
# call returns HTTP 403 "Error 1010: Access denied". A 500-key batch is also
# the practical ceiling: 1000 keys overflows the URL length (HTTP 414), and
# 500 is the documented V2 cap anyway.
BROWSER_UA: Final[str] = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


# ──────────────────────────────────────────────────────────────────────
# Curated sector → symbol map
# ──────────────────────────────────────────────────────────────────────
# Aim is ≥ 50 quality NSE cash-equity names per sector. Some narrower
# sectors (Banking, Power, Metals) have a smaller natural universe and
# will fall short — that's expected, and the resolver prints the actual
# count per sector at the end so it's visible.
#
# Symbols are NSE trading symbols (the same string you'd type into a
# broker terminal). Order inside a sector is roughly descending market
# cap, which becomes the default display order in the UI panel.


@dataclass(frozen=True)
class SectorSpec:
    """Declarative spec for one sector — fed straight into the resolver."""

    id: str
    name: str
    symbols: tuple[str, ...]


@dataclass(frozen=True)
class IndexSpec:
    """Declarative spec for one NSE index (Nifty 50, Bank, IT, etc.).

    Shape is identical to ``SectorSpec`` — only the conceptual grouping
    differs. Indices are emitted into a separate ``indices`` array in
    ``data/sectors.json`` so the JS layer can render them as a distinct
    row (e.g. visually grouped as "INDICES" above "SECTORS") while
    still reusing the same picker + quote-fetch + panel rendering code.

    Constituent lists are best-effort snapshots; NSE rebalances most
    indices semi-annually, so re-run this script after a known review
    (March / September) to catch any swaps. Missing symbols are
    surfaced in the script's stderr report.
    """

    id: str
    name: str
    symbols: tuple[str, ...]


SECTORS: Final[tuple[SectorSpec, ...]] = (
    # 1. BANKING — Private + PSU + Small Finance Banks
    SectorSpec("banking", "Banking", (
        # Private universal banks
        "HDFCBANK", "ICICIBANK", "AXISBANK", "KOTAKBANK", "INDUSINDBK",
        "FEDERALBNK", "IDFCFIRSTB", "BANDHANBNK", "RBLBANK", "YESBANK",
        "KARURVYSYA", "CUB", "DCBBANK", "SOUTHBANK", "KTKBANK",
        "J&KBANK", "TMB", "CSBBANK", "DHANBANK", "IDBI",
        # PSU banks
        "SBIN", "BANKBARODA", "PNB", "CANBK", "UNIONBANK", "INDIANB",
        "BANKINDIA", "CENTRALBK", "IOB", "MAHABANK", "UCOBANK", "PSB",
        # Small Finance Banks
        "AUBANK", "EQUITASBNK", "UJJIVANSFB", "ESAFSFB", "UTKARSHBNK",
        "SURYODAY", "FINOPB", "CAPITALSFB", "JSFB",
    )),

    # 2. FINANCIAL SERVICES — NBFCs, HFCs, Insurance, AMCs, Brokers, Exchanges
    SectorSpec("financial-services", "Financial Services", (
        # Diversified NBFCs
        "BAJFINANCE", "BAJAJFINSV", "BAJAJHLDNG", "CHOLAFIN", "SHRIRAMFIN",
        "MUTHOOTFIN", "MANAPPURAM", "M&MFIN", "LTF", "POONAWALLA",
        "ABCAPITAL", "SUNDARMFIN", "SBFC", "FEDFINA",
        # PSU NBFCs / Infra finance
        "PFC", "RECLTD", "IRFC", "IREDA", "HUDCO",
        # Diversified financial services / Fintech
        "IIFL", "JIOFIN", "POLICYBZR", "PAYTM", "CARTRADE",
        # Housing finance
        "LICHSGFIN", "CANFINHOME", "AAVAS", "APTUS", "HOMEFIRST",
        "REPCOHOME", "PNBHOUSING",
        # Insurance
        "HDFCLIFE", "SBILIFE", "LICI", "ICICIGI", "ICICIPRULI", "MFSL",
        "NIVABUPA", "GICRE", "STARHEALTH", "NIACL",
        # Asset Management
        "HDFCAMC", "NAM-INDIA", "UTIAMC", "ABSLAMC",
        # Brokers / Wealth
        "MOTILALOFS", "ANGELONE", "ANANDRATHI", "NUVAMA", "360ONE",
        "EDELWEISS", "JMFINANCIL",
        # Capital-markets infrastructure
        "BSE", "MCX", "CDSL", "KFINTECH", "CAMS", "IEX",
        # Ratings & Research
        "CRISIL", "ICRA",
        # Holding/Investment companies
        "TATAINVEST",
    )),

    # 3. IT & TECH — Tier-1 services, Tier-2 services, Products, Internet, EMS
    SectorSpec("it", "IT & Tech", (
        # Tier-1 IT services
        "TCS", "INFY", "HCLTECH", "WIPRO", "TECHM",
        # Tier-2 IT services
        "PERSISTENT", "COFORGE", "MPHASIS", "LTTS", "KPITTECH", "OFSS",
        "TATAELXSI", "BSOFT", "CYIENT", "ZENSARTECH", "MASTEK",
        "SONATSOFTW", "FSL", "ECLERX", "TATATECH", "INTELLECT",
        # Mid / Small IT services
        "NIITLTD", "NIITMTS", "HAPPSTMNDS", "RATEGAIN", "NEWGEN",
        "RSYSTEMS", "DATAMATICS", "ZAGGLE", "QUICKHEAL", "TANLA",
        "MOSCHIP", "SAKSOFT", "ROUTE",
        # Internet / Platforms / B2B SaaS
        "INDIAMART", "JUSTDIAL", "NAUKRI", "MAPMYINDIA", "AFFLE",
        "NAZARA", "TBOTEK",
        # Electronics Manufacturing Services (EMS) / Hardware
        "DIXON", "KAYNES", "AMBER", "NETWEB", "CYIENTDLM", "SYRMA",
        "AVALON",
        # Telecom equipment & Defence Tech
        "TEJASNET", "HFCL", "ITI",
        # Misc tech / consultancy
        "BLS",
    )),

    # 4. PHARMA & HEALTHCARE — Pharma, Hospitals, Diagnostics, Devices
    SectorSpec("pharma-healthcare", "Pharma & Healthcare", (
        # Indian Pharma majors
        "SUNPHARMA", "DRREDDY", "CIPLA", "AUROPHARMA", "LUPIN",
        "TORNTPHARM", "DIVISLAB", "ZYDUSLIFE", "GLENMARK", "ALKEM",
        "MANKIND", "IPCALAB", "JBCHEPHARM", "AJANTPHARM", "BIOCON",
        # MNC Pharma
        "ABBOTINDIA", "PFIZER", "SANOFI", "GLAXO", "ASTRAZEN",
        "SANOFICONR",
        # Mid / Small Pharma
        "NATCOPHARM", "GRANULES", "LAURUSLABS", "EMCURE", "ERIS",
        "SUVEN", "GLAND", "CONCORDBIO", "PPLPHARMA", "JUBLPHARMA",
        "WOCKPHARMA", "ORCHPHARMA", "MARKSANS", "MOREPENLAB", "FDC",
        "INDOCO", "CAPLIPOINT", "NEULANDLAB", "RPGLIFE", "SUPRIYA",
        "ENTERO", "MEDPLUS",
        # CDMO / Specialty
        "SYNGENE",
        # Hospital chains
        "APOLLOHOSP", "FORTIS", "MAXHEALTH", "MEDANTA", "NH",
        "KIMS", "RAINBOW", "SHALBY",
        # Diagnostics
        "LALPATHLAB", "METROPOLIS", "THYROCARE", "KRSNAA", "VIJAYA",
        # Medical Devices
        "POLYMED",
    )),

    # 5. FMCG & CONSUMER — Staples, Durables, Retail, QSR, Hotels, Q-Commerce
    SectorSpec("fmcg-consumer", "FMCG & Consumer", (
        # Pure FMCG / Staples
        "HINDUNILVR", "ITC", "NESTLEIND", "BRITANNIA", "TATACONSUM",
        "DABUR", "GODREJCP", "MARICO", "COLPAL", "UNITDSPR", "RADICO",
        "VBL", "EMAMILTD", "BAJAJCON", "JYOTHYLAB", "GILLETTE", "PGHH",
        "HONASA", "PATANJALI", "BIKAJI", "BECTORFOOD",
        # Consumer Durables / Appliances
        "TITAN", "KAJARIACER", "CERA", "CROMPTON", "VOLTAS", "BLUESTARCO",
        "SYMPHONY", "VGUARD", "BAJAJELEC", "ORIENTELEC", "WHIRLPOOL",
        "IFBIND",
        # Lifestyle Retail
        "TRENT", "DMART", "ABFRL", "VMART", "SHOPERSTOP", "MANYAVAR",
        # Footwear & Apparel
        "BATAINDIA", "RELAXO", "METROBRAND", "CAMPUS", "PAGEIND",
        # QSR / Restaurants
        "JUBLFOOD", "SAPPHIRE", "DEVYANI", "WESTLIFE",
        # Hotels
        "INDHOTEL", "EIHOTEL", "LEMONTREE", "MHRIL", "TAJGVK",
        "CHALET",
        # Q-Commerce / Internet Consumer
        "ETERNAL", "SWIGGY",
    )),

    # 6. AUTO & AUTO COMPONENTS — OEMs + Components + Tyres
    SectorSpec("auto", "Auto & Auto Components", (
        # OEMs — Passenger
        "MARUTI", "M&M", "TMPV", "EICHERMOT",
        # OEMs — 2W/3W
        "BAJAJ-AUTO", "HEROMOTOCO", "TVSMOTOR", "OLAELEC",
        # OEMs — CV / Tractor / Construction
        "ASHOKLEY", "ESCORTS", "FORCEMOT", "VSTTILLERS", "SWARAJENG",
        "ACE",
        # Tyres
        "MRF", "APOLLOTYRE", "BALKRISIND", "CEATLTD", "JKTYRE",
        # Components — Large
        "BOSCHLTD", "MOTHERSON", "BHARATFORG", "EXIDEIND", "ARE&M",
        "TIINDIA", "ENDURANCE", "SUNDRMFAST", "SCHAEFFLER", "TIMKEN",
        # Components — Mid / Small
        "UNOMINDA", "MINDACORP", "GABRIEL", "NRBBEARING", "CRAFTSMAN",
        "GNA", "JAMNAAUTO", "SUBROS", "FIEMIND", "MAHSCOOTER",
        "LUMAXIND", "LUMAXTECH", "RICOAUTO", "SSWL", "JTEKTINDIA",
        "SHRIPISTON", "WHEELS", "HARSHA", "ZFCVINDIA",
        # EV / New Mobility
        "OLECTRA", "GREAVESCOT", "ATHERENERG",
        # Auto-adjacent logistics
        "TVSSCS",
    )),

    # 7. OIL, GAS & ENERGY — Upstream, Refining, Gas, Renewables, Coal
    SectorSpec("oil-gas", "Oil, Gas & Energy", (
        # Integrated
        "RELIANCE",
        # Upstream
        "ONGC", "OIL", "HINDOILEXP",
        # Refining / Downstream
        "IOC", "BPCL", "HINDPETRO", "MRPL", "CHENNPETRO",
        # Natural Gas
        "GAIL", "IGL", "GUJGASLTD", "MGL", "PETRONET",
        "AEGISLOG", "ATGL", "IRMENERGY",
        # Lubricants & Oil derivatives
        "CASTROLIND", "GULFOILLUB", "GANDHAR", "SOTL", "KIRLOSENG",
        # Adani Energy
        "ADANIENT",
        # Renewables / Solar / Wind / EV-energy
        "ADANIGREEN", "SUZLON", "INOXWIND", "INOXGREEN", "KPIGREEN",
        "WAAREEENER", "PREMIERENE", "GREENPOWER", "NTPCGREEN",
        "SAATVIKGL", "WEBELSOLAR", "UTLSOLAR",
        # Coal / Lignite
        "COALINDIA", "NLCINDIA",
        # Power-equipment for energy projects
        "TRITURBINE",
    )),

    # 8. POWER & UTILITIES — Generation + Transmission + Equipment + Cables
    SectorSpec("power", "Power & Utilities", (
        # PSU generation / transmission
        "NTPC", "POWERGRID", "NHPC", "SJVN", "NLCINDIA",
        # Private generation
        "TATAPOWER", "ADANIPOWER", "JSWENERGY", "TORNTPOWER", "CESC",
        "RPOWER", "JPPOWER",
        # NTPC subsidiary
        "NTPCGREEN",
        # Adani transmission
        "ADANIENSOL",
        # Power equipment / industrial automation
        "ABB", "SIEMENS", "BHEL", "CGPOWER", "POWERMECH", "POWERINDIA",
        "TDPOWERSYS", "SCHNEIDER", "BAJEL", "HONDAPOWER", "GENUSPOWER",
        # Cables & Wires
        "POLYCAB", "KEI", "RRKABEL", "HAVELLS", "FINCABLES", "DIACABS",
        # Solar / Wind (shared with oil-gas — kept here too for discovery)
        "ADANIGREEN", "SUZLON", "INOXWIND", "INOXGREEN", "KPIGREEN",
        "WAAREEENER", "PREMIERENE", "GREENPOWER", "SAATVIKGL",
        # Solar EPC / Manufacturing
        "WEBELSOLAR", "UTLSOLAR",
        # Energy exchanges
        "IEX",
    )),

    # 9. METALS & MINING — Steel, Aluminium, Copper, Zinc, Coal, Pipes
    SectorSpec("metals", "Metals & Mining", (
        # Integrated Steel
        "TATASTEEL", "JSWSTEEL", "JINDALSTEL", "SAIL", "JSL",
        "SUNFLAG", "SHYAMMETL", "LLOYDSME", "BEEKAY",
        # Pipes & Tubes
        "APLAPOLLO", "JINDALSAW", "WELCORP", "MAHSEAMLES", "RATNAMANI",
        "JTLIND", "VENUSPIPES", "HARIOMPIPE", "APOLLOPIPE", "PRINCEPIPE",
        "SAMBHV", "SSWL", "STEELCAS",
        # Non-Ferrous
        "HINDALCO", "VEDL", "HINDZINC", "NATIONALUM",
        # Mining
        "NMDC", "COALINDIA", "MOIL", "GMDCLTD",
        # Speciality / Recycling
        "GRAVITA", "POCL", "POKARNA",
        # Castings / Foundries / Ferro-alloys
        "ELECTCAST", "MAITHANALL", "FACT", "IMFA",
    )),

    # 10. CEMENT & CONSTRUCTION — Cement, EPC, Infrastructure builders
    SectorSpec("cement-construction", "Cement & Construction", (
        # Cement majors
        "ULTRACEMCO", "GRASIM", "AMBUJACEM", "ACC", "SHREECEM",
        "DALBHARAT", "RAMCOCEM", "JKCEMENT", "JKLAKSHMI", "INDIACEM",
        "BIRLACORPN", "HEIDELBERG", "ORIENTCEM", "PRSMJOHNSN", "SAGCEM",
        "JSWCEMENT", "STARCEMENT", "DECCANCE", "MANGLMCEM", "SAURASHCEM",
        # EPC / Construction / Airports
        "LT", "GMRAIRPORT", "GMRP&UI", "IRB", "KEC",
        "NCC", "HGINFRA", "PNCINFRA", "KNRCON", "JKIL", "DBL",
        "ASHOKA", "ISGEC", "PSPPROJECT", "AHLUCONT", "AFCONS",
        "CAPACITE", "MBLINFRA", "HCC", "RAMKY", "GRINFRA",
        "POWERMECH", "MADHAVIPL", "RKEC",
        # Ceramics / Sanitaryware / Construction materials
        "KAJARIACER", "CERA", "ASTRAL", "PRINCEPIPE", "SUPREMEIND",
        # Plywood
        "GREENPLY", "CENTURYPLY",
    )),

    # 11. CAPITAL GOODS & INDUSTRIALS — Engineering, Defence, Paints, Chemicals
    SectorSpec("industrial-goods", "Capital Goods & Industrials", (
        # Industrial automation / electricals
        "ABB", "SIEMENS", "CGPOWER", "HAVELLS", "POLYCAB", "KEI",
        "RRKABEL", "FINCABLES", "SCHNEIDER",
        # Engineering / Machinery
        "CUMMINSIND", "THERMAX", "TRITURBINE", "PRAJIND", "ELGIEQUIP",
        "GRINDWELL", "TIMKEN", "SKFINDIA", "SCHAEFFLER", "AIAENG",
        "KIRLOSBROS", "KIRLOSENG",
        # Defence / PSU industrial
        "BEL", "HAL", "BEML", "MAZDOCK", "BDL", "GRSE", "COCHINSHIP",
        "MIDHANI", "ASTRAMICRO", "DATAPATTNS", "MTARTECH", "PARAS",
        # Forging & Wind components
        "BHARATFORG", "JINDALSAW", "SUZLON", "INOXWIND",
        # Paints
        "ASIANPAINT", "BERGEPAINT", "KANSAINER", "INDIGOPNTS",
        # Adhesives
        "PIDILITIND",
        # Speciality Chemicals
        "SRF", "PIIND", "DEEPAKNTR", "TATACHEM", "GUJALKALI",
        "AARTIIND", "NAVINFLUOR", "VINATIORGA", "ATUL", "GHCL",
        "ALKYLAMINE", "JUBLINGREA", "CLEAN", "FINEORG", "ROSSARI",
        "GALAXYSURF", "EPL", "ANURAS",
        # Fertilisers
        "COROMANDEL", "CHAMBLFERT", "RCF", "GNFC", "DEEPAKFERT",
        # Industrial misc
        "VOLTAMP", "TRIVENI", "ELECON", "ACE",
    )),

    # 12. TELECOM, INFRA & REALTY — Telecom, Towers, Ports, Logistics, Realty
    SectorSpec("telecom-infra", "Telecom, Infra & Realty", (
        # Telecom Operators
        "BHARTIARTL", "IDEA", "TATACOMM", "BHARTIHEXA",
        # Telecom Infrastructure / Equipment
        "INDUSTOWER", "HFCL", "TEJASNET", "ITI",
        # Ports / Shipping
        "ADANIPORTS", "GESHIP", "SCI", "JSWINFRA",
        # Aviation
        "INDIGO",
        # Logistics & Supply Chain
        "CONCOR", "BLUEDART", "DELHIVERY", "MAHLOG", "TCI", "VRLLOG",
        "TIMETECHNO", "ALLCARGO", "TCIEXP", "SNOWMAN",
        # Railways & Rail-tech
        "IRCTC", "RAILTEL", "RVNL", "TITAGARH", "JWL", "TEXRAIL",
        "IRCON",
        # Realty Developers
        "DLF", "LODHA", "GODREJPROP", "OBEROIRLTY", "PRESTIGE", "BRIGADE",
        "PHOENIXLTD", "MAHLIFE", "SOBHA", "SUNTECK", "SIGNATURE",
        "RAYMOND", "RAYMONDREL", "ARVSMART", "AJMERA", "MOREALTY",
    )),
)


# ──────────────────────────────────────────────────────────────────────
# NSE index constituents (Nifty 50, Next 50, Bank, IT)
# ──────────────────────────────────────────────────────────────────────
# Best-effort snapshots as of the last script run; NSE reviews most
# indices every March + September so re-run after either window.
# Symbols missing from the Upstox NSE master are printed at the end
# of the script run so you can patch the lists below.
#
# Nifty 50 = NIFTY benchmark (top 50 by free-float market cap)
# Nifty Next 50 = ranks 51-100 (i.e. Nifty 100 minus Nifty 50)
# Nifty Bank = 12 banking stocks (the NIFTY BANK / "Bank Nifty" index)
# Nifty IT = 10 IT-services stocks (the NIFTY IT sectoral index)
# Nifty 500 is far too large (≈500 names) to hand-curate here and NSE
# rebalances it constantly, so its constituents are pulled live from the
# NSE-published CSV at generation time (see ``fetch_nse_index_symbols``)
# rather than hardcoded. Nifty 100 = Nifty 50 + Nifty Next 50, so it is
# composed from the two tuples below — no separate list to keep in sync.
NIFTY_500_CSV_URL: Final[str] = (
    "https://archives.nseindia.com/content/indices/ind_nifty500list.csv"
)

NIFTY_50_SYMS: Final[tuple[str, ...]] = (
    "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS",
    "BHARTIARTL", "ITC", "LT", "SBIN", "HCLTECH",
    "BAJFINANCE", "HINDUNILVR", "MARUTI", "SUNPHARMA", "KOTAKBANK",
    "M&M", "NTPC", "AXISBANK",
    # Post-demerger Tata Motors trades as TMPV (passenger) /
    # TMCV (commercial); the index inherits the passenger entity.
    "TMPV",
    "ADANIPORTS",
    "ONGC", "TITAN", "POWERGRID", "ULTRACEMCO", "ASIANPAINT",
    "WIPRO", "COALINDIA", "BAJAJ-AUTO", "JSWSTEEL", "NESTLEIND",
    "INDUSINDBK", "HINDALCO", "TATACONSUM", "BAJAJFINSV", "TECHM",
    "CIPLA", "APOLLOHOSP", "EICHERMOT", "BPCL", "DRREDDY",
    "BRITANNIA", "GRASIM", "HEROMOTOCO", "TATASTEEL", "SBILIFE",
    "HDFCLIFE", "BEL", "SHRIRAMFIN", "TRENT", "ADANIENT",
)

NIFTY_NEXT_50_SYMS: Final[tuple[str, ...]] = (
    # Banking / Financial Services
    "BANKBARODA", "CANBK", "PNB", "PFC", "RECLTD", "IRFC",
    "CHOLAFIN", "BAJAJHLDNG", "ICICIGI", "ICICIPRULI",
    "HDFCAMC", "LICI", "SBICARD",
    # Consumer / FMCG
    "DABUR", "GODREJCP", "MARICO", "COLPAL", "VBL", "UNITDSPR",
    # Pharma
    "ZYDUSLIFE",
    # Auto / Auto Components
    "MOTHERSON", "TVSMOTOR", "BOSCHLTD",
    # Industrials / Capital Goods
    "ABB", "SIEMENS", "BHEL", "CGPOWER", "HAVELLS",
    # Power / Energy
    "TATAPOWER", "NHPC", "GAIL", "IOC",
    # Metals & Mining
    "JINDALSTEL", "NMDC", "VEDL",
    # Cement
    "AMBUJACEM", "SHREECEM",
    # Realty
    "DLF", "LODHA",
    # Adani Group
    "ADANIGREEN", "ADANIENSOL",
    # Internet / Retail
    "NAUKRI", "DMART", "ETERNAL", "SWIGGY",
    # Travel / Hospitality
    "INDIGO", "INDHOTEL", "IRCTC",
    # Paints
    "BERGEPAINT", "PIDILITIND",
    # Chemicals / Speciality
    "PIIND", "SRF",
)

INDICES: Final[tuple[IndexSpec, ...]] = (
    IndexSpec("nifty-50", "Nifty 50", NIFTY_50_SYMS),

    IndexSpec("nifty-next-50", "Nifty Next 50", NIFTY_NEXT_50_SYMS),

    # Nifty 100 = Nifty 50 ∪ Nifty Next 50 (resolve_group dedupes).
    IndexSpec("nifty-100", "Nifty 100", NIFTY_50_SYMS + NIFTY_NEXT_50_SYMS),

    IndexSpec("nifty-bank", "Nifty Bank", (
        "HDFCBANK", "ICICIBANK", "AXISBANK", "SBIN", "KOTAKBANK",
        "INDUSINDBK", "BANKBARODA", "FEDERALBNK", "IDFCFIRSTB", "PNB",
        "AUBANK", "CANBK",
    )),

    IndexSpec("nifty-it", "Nifty IT", (
        # Note: LTIMindtree (LTIM) is currently missing from the Upstox
        # NSE master — this index would normally include it. Re-check
        # after the next Upstox data refresh and add "LTIM" back.
        "TCS", "INFY", "HCLTECH", "WIPRO", "TECHM",
        "MPHASIS", "PERSISTENT", "COFORGE", "LTTS",
    )),
)


# ──────────────────────────────────────────────────────────────────────
# Plumbing
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Stock:
    """One resolved stock — what gets emitted into sectors.json."""

    sym: str
    isin: str
    name: str


# Tokens preserved in their original case (acronyms) during name cleanup.
LOWER_WORDS: Final[frozenset[str]] = frozenset({
    "OF", "AND", "FOR", "IN", "ON", "AT", "THE", "A", "AN", "TO"
})


def clean_name(raw: str) -> str:
    """Turn an Upstox raw company name into a display-friendly variant.

    Drops the ``LIMITED`` / ``LTD`` suffix and title-cases if the whole
    string is uppercase. Tokens of ≤ 3 characters are preserved in
    their original case so acronyms like HDFC / NTPC / ITC stay
    uppercase; common prepositions (``of`` / ``and`` / ``for``) are
    lowercased mid-string. Imperfect on a few words (e.g. OIL → OIL,
    not Oil) but the trading symbol is shown alongside in the UI, so
    name ambiguity isn't a blocker — and the alternative (hand-curating
    600 names) is far worse.
    """
    n = raw.strip()
    upper = n.upper()
    for suf in (" LIMITED", " LTD.", " LTD"):
        if upper.endswith(suf):
            n = n[: -len(suf)].strip()
            break
    if not n.isupper():
        return n
    out: list[str] = []
    for i, w in enumerate(n.split()):
        if w == "&":
            out.append("&")
        elif i > 0 and w in LOWER_WORDS:
            out.append(w.lower())
        elif len(w) <= 3 and i > 0:
            out.append(w)
        else:
            out.append(w.capitalize())
    return " ".join(out)


def download_master(url: str) -> list[dict]:
    """Fetch + decompress the Upstox NSE instruments JSON (~5 MB gz)."""
    print(f"Downloading {url} …", file=sys.stderr)
    # Upstox assets sit behind Cloudflare, which 1010-blocks the default
    # urllib UA. A normal browser UA clears it.
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0 Safari/537.36"
            )
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
    print(
        f"  {len(raw) / 1024 / 1024:.1f} MB compressed, decompressing …",
        file=sys.stderr,
    )
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as gz:
        instruments = json.load(gz)
    if not isinstance(instruments, list):
        raise RuntimeError(
            f"Expected list at top level, got {type(instruments).__name__}"
        )
    print(f"  {len(instruments):,} instruments parsed", file=sys.stderr)
    return instruments


def build_lookup(instruments: list[dict]) -> dict[str, dict]:
    """Index NSE_EQ cash equities by trading_symbol.

    Filters out F&O, debt, ETFs, indices, and BSE rows. Keeps the first
    instrument per symbol (Upstox occasionally has duplicates for
    legacy series codes — the first one is invariably the active EQ).
    """
    out: dict[str, dict] = {}
    skipped_no_isin = 0
    for inst in instruments:
        if inst.get("segment") != "NSE_EQ":
            continue
        if inst.get("instrument_type") not in ("EQ", "Equity"):
            continue
        sym = inst.get("trading_symbol") or inst.get("tradingsymbol")
        if not sym:
            continue
        if not inst.get("isin"):
            skipped_no_isin += 1
            continue
        if sym in out:
            continue  # first-wins dedup
        out[sym] = inst
    if skipped_no_isin:
        print(
            f"  skipped {skipped_no_isin} rows missing ISIN",
            file=sys.stderr,
        )
    print(
        f"  {len(out):,} NSE_EQ symbols with ISIN indexed",
        file=sys.stderr,
    )
    return out


# BSE doesn't tag rows ``instrument_type=EQ`` like NSE. The BSE_EQ segment
# instead carries the exchange's *scrip-group* code in instrument_type, and
# the segment mixes ordinary equity shares with debt, govt paper, ETFs,
# REITs/InvITs and rights entitlements. Per the project rule "only equity
# shares", we EXCLUDE the clearly non-equity groups and treat every other
# group as common equity (so a future new equity-group code isn't silently
# dropped). Verified against sampled names from the live BSE master:
#   F  = bonds / NCDs / CPs        (e.g. "IRFC-7.75%-15-4-33-PVT")
#   G  = govt securities / SDLs    (e.g. "742KERSDL34")
#   IF = REIT / InvIT units        (e.g. "IRB InvIT Fund", PropShare)
#   E  = ETFs / mutual-fund units  (e.g. "LIC MF GOLD")
#   R  = rights entitlements       (e.g. "AVG-RE")
# Everything else (A/B/T/X/XT/M/MT/MS/P/TS/Z/ZP/…) is an equity share.
BSE_NON_EQUITY_GROUPS: Final[frozenset[str]] = frozenset({
    "F", "G", "IF", "E", "R",
})


def build_bse_lookup(instruments: list[dict]) -> dict[str, dict]:
    """Index BSE_EQ equity shares by trading_symbol.

    Mirrors ``build_lookup`` but for the BSE master. Only used to widen
    the flat instruments-index with BSE-only names; the curated sectors /
    indices stay NSE-only (their symbol lists are NSE tickers). Filters:
    segment BSE_EQ, an equity-share scrip group (i.e. NOT one of
    ``BSE_NON_EQUITY_GROUPS``), has ISIN, first-wins dedupe.
    """
    out: dict[str, dict] = {}
    skipped_no_isin = 0
    skipped_non_equity = 0
    for inst in instruments:
        if inst.get("segment") != "BSE_EQ":
            continue
        if (inst.get("instrument_type") or "") in BSE_NON_EQUITY_GROUPS:
            skipped_non_equity += 1
            continue
        sym = inst.get("trading_symbol") or inst.get("tradingsymbol")
        if not sym:
            continue
        if not inst.get("isin"):
            skipped_no_isin += 1
            continue
        if sym in out:
            continue  # first-wins dedup
        out[sym] = inst
    if skipped_no_isin:
        print(
            f"  skipped {skipped_no_isin} rows missing ISIN",
            file=sys.stderr,
        )
    if skipped_non_equity:
        print(
            f"  skipped {skipped_non_equity} non-equity rows "
            f"(debt / govt / ETF / REIT / rights)",
            file=sys.stderr,
        )
    print(
        f"  {len(out):,} BSE_EQ equity shares with ISIN indexed",
        file=sys.stderr,
    )
    return out


def resolve_group(
    spec: SectorSpec | IndexSpec, lookup: Mapping[str, dict]
) -> tuple[list[Stock], list[str]]:
    """Look up each curated symbol in the master. Skip + warn on misses.

    Used for both sectors (industry buckets) and indices (NSE benchmark
    buckets). The two share the same ``{id, name, symbols}`` shape, so
    one resolver covers both.
    """
    found: list[Stock] = []
    missing: list[str] = []
    seen: set[str] = set()
    for sym in spec.symbols:
        if sym in seen:
            continue
        seen.add(sym)
        inst = lookup.get(sym)
        if not inst:
            missing.append(sym)
            continue
        name = clean_name(inst.get("name") or sym)
        found.append(Stock(sym=sym, isin=inst["isin"], name=name))
    return found, missing


# ──────────────────────────────────────────────────────────────────────
# AUTO-CLASSIFICATION ENGINE
# ──────────────────────────────────────────────────────────────────────
# Uses two data sources in priority order:
#   1. NSE's official industry classification (from broad-index CSVs)
#   2. Company-name keyword matching (heuristic fallback)
# Maps to the app's sector IDs (existing 12 + 4 new).

# NSE industry → app sector ID mapping
_NSE_INDUSTRY_MAP: Final[dict[str, str]] = {
    "Financial Services": "financial-services",
    "Capital Goods": "industrial-goods",
    "Healthcare": "pharma-healthcare",
    "Automobile and Auto Components": "auto",
    "Consumer Services": "fmcg-consumer",
    "Fast Moving Consumer Goods": "fmcg-consumer",
    "Chemicals": "chemicals",
    "Consumer Durables": "fmcg-consumer",
    "Information Technology": "it",
    "Services": "services",
    "Metals & Mining": "metals",
    "Construction": "cement-construction",
    "Power": "power",
    "Oil Gas & Consumable Fuels": "oil-gas",
    "Realty": "telecom-infra",
    "Construction Materials": "cement-construction",
    "Telecommunication": "telecom-infra",
    "Textiles": "textiles",
    "Media Entertainment & Publication": "media",
    "Utilities": "power",
    "Diversified": "services",
    "Forest Materials": "services",
}

# Keyword patterns for name-based classification (checked in order, first match wins)
_KEYWORD_RULES: Final[list[tuple[str, list[str]]]] = [
    # (sector_id, [keywords that trigger it])
    # Checked in order — first match wins. More specific rules must come first.
    ("banking", ["bank", "banc"]),
    ("financial-services", [
        "financ", "finserv", "fincorp", "capital", "insurance",
        "invest", "credit", "leasing", "lending", "broking",
        "wealth", "asset management", "amc", "mutual fund",
        "microfinance", "housing fin", "home fin", "nbfc",
        "securit", "holding", "venture", "fund ",
        "money", "forex",
    ]),
    ("it", [
        "software", "infotech", "technologies", "tech ",
        "techno", "digital", " it ", "infosys", "comput",
        "data ", "cloud", "cyber", "internet", "dotcom",
        "e-commerce", "ecommerce", "saas", "electron",
        "network", "system", "solution",
        "communicat", "infocom",
    ]),
    ("pharma-healthcare", [
        "pharma", "health", "hospital", "medical", "medic",
        "diagnostic", "biotech", "drug", "life sci", "lifesci",
        "therapeut", "oncology", "surgical", "dental",
        "patholog", "clinic", "care ", "laborator", " lab",
        "nutra", "wellness",
    ]),
    ("chemicals", [
        "chemical", "chem ", "chemi", "organi", "solvent",
        "pigment", "dye", "color", "colour", "acid",
        "polymer", "resin", "adhesive", "specialty chem",
        "rubber", "plastic", "petrochem", "agrochem",
        "fertiliz", "fertiliser", "pesticide", "crop",
    ]),
    ("auto", [
        "motor", "auto", "tyre", "tire", "vehicle",
        "scooter", "tractor", "two wheel", "car ",
        "axle", "brake", "gear", "piston", "bearing",
    ]),
    ("oil-gas", [
        "oil ", " oil", "gas ", "petro", "fuel", "energy",
        "refiner", "lubricant", "lng ", "cng ",
    ]),
    ("power", [
        "power", "electri", "solar", "wind ", "renewable",
        "hydro", "generat", "transmis", "transformer",
        "cable", "wire", "conductor",
    ]),
    ("metals", [
        "steel", "metal", "iron", "mining", "alumin",
        "copper", "zinc", "alloy", "foundry", "forge",
        "casting", "ferro", "pipe", "tube", "ispat",
    ]),
    ("cement-construction", [
        "cement", "construct", "infra", "build",
        "engineer", "project", "road", "bridge",
        "contractor", "civil",
    ]),
    ("industrial-goods", [
        "industrial", "machine", "manufactur",
        "equipment", "tools", "instrument",
        "defence", "defense", "aerospace", "ship",
        "valve", "pump", "compressor", "boiler",
        "paint", "coat", "paper", "packaging",
        "abrasive",
    ]),
    ("telecom-infra", [
        "telecom", "realty", "real estate", "property",
        "housing", " tower", "logistic", "transport",
        "shipping", "port ", "airport", "rail",
        "warehouse", "developer",
    ]),
    ("fmcg-consumer", [
        "food", "beverage", "dairy", "sugar", "agro",
        "consumer", "personal care", "soap", "hotel",
        "restaurant", "hospitality", "retail",
        "garment", "apparel", "fashion", "jewel",
        "tile", "glass", "furniture",
        "tobacco", "tea ", "coffee", "edible",
    ]),
    ("textiles", [
        "textile", "yarn", "fabric", "cotton", "silk",
        "spinning", "spinner", "weaving", "denim", "jute",
        "linen", "knit", "synthetic", "polyester", "nylon",
        "fibre", " mills", "polytex",
    ]),
    ("media", [
        "media", "entertainment", "film", "broadcast",
        "publish", "print", "news", "advertis",
        "television", "radio", "content", "education",
    ]),
]


def fetch_nse_index_symbols(url: str) -> tuple[str, ...]:
    """Download an NSE index CSV and return its trading symbols in order.

    Used for indices too large / too churny to hand-curate (Nifty 500).
    Returns an empty tuple on any network/parse failure so the caller can
    fail safe (skip that index) rather than emit a partial guess.
    """
    import csv as _csv

    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0 Safari/537.36"
                )
            },
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read().decode("utf-8-sig")
    except Exception as exc:  # noqa: BLE001 — fail safe, skip the index
        print(f"  ! could not fetch {url}: {exc}", file=sys.stderr)
        return ()
    syms: list[str] = []
    seen: set[str] = set()
    for row in _csv.DictReader(io.StringIO(data)):
        sym = (row.get("Symbol") or "").strip()
        if sym and sym not in seen:
            seen.add(sym)
            syms.append(sym)
    return tuple(syms)


def _fetch_nse_industries() -> dict[str, str]:
    """Download NSE broad-index CSVs and build {symbol: industry} map.

    Returns the official NSE industry classification for ~750 stocks.
    Silently returns empty on network failure (fallback to keywords).
    """
    urls = [
        "https://archives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv",
        "https://archives.nseindia.com/content/indices/ind_nifty500list.csv",
        "https://archives.nseindia.com/content/indices/ind_niftymicrocap250_list.csv",
        "https://archives.nseindia.com/content/indices/ind_niftylargemidcap250list.csv",
        "https://archives.nseindia.com/content/indices/ind_niftymidsmallcap400list.csv",
        "https://archives.nseindia.com/content/indices/ind_niftysmallcap250list.csv",
        "https://archives.nseindia.com/content/indices/ind_niftysmallcap50list.csv",
    ]
    import csv as _csv
    out: dict[str, str] = {}
    for url in urls:
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0 Safari/537.36"
                    )
                },
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read().decode("utf-8-sig")
            for row in _csv.DictReader(io.StringIO(data)):
                sym = (row.get("Symbol") or "").strip()
                ind = (row.get("Industry") or "").strip()
                if sym and ind and sym not in out:
                    out[sym] = ind
        except Exception:
            continue
    print(
        f"  NSE industry data: {len(out)} symbols classified",
        file=sys.stderr,
    )
    return out


def _classify_stock(
    sym: str,
    name: str,
    isin: str,
    nse_industry: dict[str, str],
) -> str:
    """Determine which sector a stock belongs to.

    Priority: (1) official NSE industry tag, (2) keyword match on name.
    Returns the sector ID string.
    """
    # 1. NSE official industry
    ind = nse_industry.get(sym)
    if ind:
        mapped = _NSE_INDUSTRY_MAP.get(ind)
        if mapped:
            # Financial Services needs bank split
            if mapped == "financial-services" and _name_has(name, ["bank", "banc"]):
                return "banking"
            return mapped

    # 2. Keyword matching on company name (lowercase)
    lower = f" {name.lower()} "
    for sector_id, keywords in _KEYWORD_RULES:
        for kw in keywords:
            if kw in lower:
                return sector_id

    # 3. Fallback
    return "services"


def _name_has(name: str, keywords: list[str]) -> bool:
    lower = name.lower()
    return any(kw in lower for kw in keywords)


def emit_instruments_index(
    nse_lookup: Mapping[str, dict],
    bse_lookup: Mapping[str, dict],
    out_path: Path,
) -> tuple[int, int]:
    """Write data/instruments-index.json — a flat sym → [isin, name(, exch)] map.

    Powers the "Add custom stock" flow + full-universe scan in the swing
    tab: the UI looks symbols up here to auto-fill ISIN + name (and now
    exchange) without a network round trip.

    Value shape is a compact array per entry (saves ~30 % vs an object):

      • NSE row → ``[isin, name]``           (2 elements; exch implied NSE)
      • BSE-only row → ``[isin, name, "BSE"]`` (3rd element flags exchange)

    BSE-only means the ISIN is absent from the NSE master, so dual-listed
    names always resolve to their NSE instrument key. The JS-side helper
    reads ``exch = pair[2] || "NSE"`` and builds ``<exch>_EQ|<isin>``.

    Returns ``(nse_count, bse_only_count)``.
    """
    flat: dict[str, list[str]] = {}
    nse_isins: set[str] = set()
    for sym, inst in nse_lookup.items():
        isin = inst["isin"]
        nse_isins.add(isin)
        flat[sym] = [isin, clean_name(inst.get("name") or sym)]

    bse_only = 0
    for sym, inst in bse_lookup.items():
        isin = inst["isin"]
        if isin in nse_isins:
            continue  # dual-listed — NSE wins, skip the BSE row
        # Symbol collisions across exchanges are rare but possible; suffix
        # the BSE symbol so it can't clobber an NSE entry in the flat map.
        key = sym if sym not in flat else f"{sym}.BSE"
        flat[key] = [isin, clean_name(inst.get("name") or sym), "BSE"]
        bse_only += 1

    payload = {
        "version": 2,
        "updated": date.today().isoformat(),
        "note": (
            "Auto-generated by scripts/tools/generate-sectors.py — flat symbol → "
            "[ISIN, clean name, exch?] lookup used by the swing tab's 'Add "
            "custom stock' modal + full-universe scan. NSE_EQ rows are "
            "2-element (exch implied NSE); BSE-only rows carry a 3rd "
            "element \"BSE\". Dual-listed ISINs resolve to NSE. Re-run the "
            "script to refresh."
        ),
        "stocks": flat,
    }
    out_path.write_text(
        json.dumps(payload, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return len(nse_lookup), bse_only


def read_upstox_token(repo_root: Path) -> str | None:
    """Read the Upstox access token from data/config.json (best-effort).

    Returns ``None`` when the file is missing / malformed / tokenless so the
    caller can degrade gracefully (emit sectors.json without prices rather
    than abort). The price snapshot is a nice-to-have, never a hard
    dependency of the file's correctness.
    """
    cfg = repo_root / "data" / "config.json"
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    tok = data.get("upstox_token") if isinstance(data, dict) else None
    return tok.strip() if isinstance(tok, str) and tok.strip() else None


def fetch_ltp_prices(keys: tuple[str, ...], token: str) -> dict[str, float]:
    """Fetch last-traded price per instrument key via the Upstox V2 LTP API.

    ``keys`` are full instrument keys (e.g. ``NSE_EQ|INE040A01034``). Returns
    ``{isin: last_price}`` for every key Upstox answered with a positive
    price. Batched at 500 keys/request (the V2 cap). Best-effort and
    fail-safe: a failed / throttled batch is logged and skipped — it never
    aborts the run, so a transient 401/429 degrades to "fewer prices known"
    rather than losing the whole file. The ISIN is recovered from the
    response's ``instrument_token`` (shaped ``SEGMENT|ISIN``), which is the
    same join key the rest of the pipeline uses.
    """
    out: dict[str, float] = {}
    total = len(keys)
    batches = (total + LTP_BATCH - 1) // LTP_BATCH
    for bi in range(batches):
        batch = keys[bi * LTP_BATCH : (bi + 1) * LTP_BATCH]
        param = ",".join(quote(k, safe="") for k in batch)
        req = urllib.request.Request(
            f"{UPSTOX_LTP_URL}?instrument_key={param}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": BROWSER_UA,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.load(resp)
        except Exception as exc:  # noqa: BLE001 — degrade, never abort
            print(
                f"  LTP batch {bi + 1}/{batches} failed ({exc}); "
                f"skipping {len(batch)} keys",
                file=sys.stderr,
            )
            time.sleep(0.5)
            continue
        data = (payload or {}).get("data") or {}
        for rec in data.values():
            if not isinstance(rec, dict):
                continue
            key = rec.get("instrument_token") or rec.get("instrument_key") or ""
            isin = str(key).split("|")[-1]
            try:
                px = float(rec.get("last_price"))
            except (TypeError, ValueError):
                continue
            if isin and px > 0:
                out[isin] = round(px, 2)
        print(
            f"  LTP batch {bi + 1}/{batches} — "
            f"{min((bi + 1) * LTP_BATCH, total)}/{total} keys, "
            f"{len(out)} priced so far",
            file=sys.stderr,
        )
        time.sleep(0.2)
    return out


def attach_prices(
    sectors_out: list[dict],
    indices_out: list[dict],
    nse_isins: set[str],
    repo_root: Path,
) -> None:
    """Mutate every stock dict in-place, adding a ``price`` snapshot.

    Collects the unique instrument keys across all sectors + indices (a
    stock like RELIANCE appears in several groups), fetches their LTP in
    one batched pass, then writes ``price`` back onto each occurrence.
    Stocks Upstox couldn't price simply get no ``price`` key — the JS card
    renderer treats a missing price as "unknown" and falls back to the
    plain total, so the file stays valid either way.
    """
    token = read_upstox_token(repo_root)
    if not token:
        print(
            "\nNo Upstox token in data/config.json — skipping price snapshot "
            "(sector cards will show plain totals).",
            file=sys.stderr,
        )
        return

    seen: dict[str, None] = {}
    for grp in (*sectors_out, *indices_out):
        for st in grp["stocks"]:
            seg = "NSE_EQ" if st["isin"] in nse_isins else "BSE_EQ"
            seen.setdefault(f"{seg}|{st['isin']}", None)
    keys = tuple(seen.keys())
    print(
        f"\nFetching LTP snapshot for {len(keys)} unique instruments …",
        file=sys.stderr,
    )
    price_by_isin = fetch_ltp_prices(keys, token)

    priced = 0
    for grp in (*sectors_out, *indices_out):
        for st in grp["stocks"]:
            px = price_by_isin.get(st["isin"])
            if px is not None:
                st["price"] = px
                priced += 1
    print(
        f"  attached prices to {priced} stock entries "
        f"({len(price_by_isin)} unique ISINs priced)",
        file=sys.stderr,
    )


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent.parent
    sectors_path = repo_root / "data" / "sectors.json"
    instruments_path = repo_root / "data" / "instruments-index.json"

    instruments = download_master(NSE_MASTER_URL)
    lookup = build_lookup(instruments)

    bse_instruments = download_master(BSE_MASTER_URL)
    bse_lookup = build_bse_lookup(bse_instruments)

    print("\nResolving sectors:", file=sys.stderr)
    sectors_out: list[dict] = []
    total_sector_stocks = 0
    grand_missing: list[tuple[str, list[str]]] = []
    for spec in SECTORS:
        stocks, missing = resolve_group(spec, lookup)
        marker = "✓" if len(stocks) >= 50 else " "
        print(
            f"  {marker} [{spec.id:22}] {spec.name:35} {len(stocks):3} stocks",
            file=sys.stderr,
        )
        if missing:
            grand_missing.append((spec.id, missing))
        sectors_out.append({
            "id": spec.id,
            "name": spec.name,
            "stocks": [
                {"sym": s.sym, "isin": s.isin, "name": s.name}
                for s in stocks
            ],
        })
        total_sector_stocks += len(stocks)

    print("\nResolving indices:", file=sys.stderr)
    indices_out: list[dict] = []
    total_index_stocks = 0
    for spec in INDICES:
        stocks, missing = resolve_group(spec, lookup)
        marker = "✓" if len(stocks) >= len(spec.symbols) else " "
        print(
            f"  {marker} [{spec.id:22}] {spec.name:35} {len(stocks):3} stocks",
            file=sys.stderr,
        )
        if missing:
            grand_missing.append((spec.id, missing))
        indices_out.append({
            "id": spec.id,
            "name": spec.name,
            "stocks": [
                {"sym": s.sym, "isin": s.isin, "name": s.name}
                for s in stocks
            ],
        })
        total_index_stocks += len(stocks)

    # Nifty 500 — too large to hardcode, so its constituents come live from
    # the NSE-published CSV. Fail safe: if the fetch fails we simply omit the
    # index rather than ship a partial / stale broad-market scope. Inserted
    # right after Nifty 100 so the row reads 50 → next-50 → 100 → 500 → …
    n500_syms = fetch_nse_index_symbols(NIFTY_500_CSV_URL)
    if n500_syms:
        spec500 = IndexSpec("nifty-500", "Nifty 500", n500_syms)
        stocks, missing = resolve_group(spec500, lookup)
        marker = "✓" if len(stocks) >= len(spec500.symbols) else " "
        print(
            f"  {marker} [{spec500.id:22}] {spec500.name:35} {len(stocks):3} stocks",
            file=sys.stderr,
        )
        if missing:
            grand_missing.append((spec500.id, missing))
        entry500 = {
            "id": spec500.id,
            "name": spec500.name,
            "stocks": [
                {"sym": s.sym, "isin": s.isin, "name": s.name}
                for s in stocks
            ],
        }
        insert_at = next(
            (i + 1 for i, ix in enumerate(indices_out)
             if ix["id"] == "nifty-100"),
            len(indices_out),
        )
        indices_out.insert(insert_at, entry500)
        total_index_stocks += len(stocks)
    else:
        print(
            "  ! Nifty 500 skipped (CSV unavailable) — re-run when online",
            file=sys.stderr,
        )

    if grand_missing:
        print("\nSymbols not found in NSE master (skipped):", file=sys.stderr)
        for group_id, missing in grand_missing:
            print(f"  [{group_id}] {', '.join(missing)}", file=sys.stderr)

    # ──────────────────────────────────────────────────────────────────
    # AUTO-CLASSIFICATION: distribute ALL remaining stocks into sectors
    # ──────────────────────────────────────────────────────────────────
    # Step 1: collect ISINs already placed in a curated sector
    placed_isins: set[str] = set()
    for sec in sectors_out:
        for st in sec["stocks"]:
            placed_isins.add(st["isin"])

    # Step 2: download NSE industry classification from index CSVs
    nse_industry = _fetch_nse_industries()

    # Step 3: auto-classify every unplaced stock (NSE + BSE)
    sector_id_map: dict[str, int] = {
        sec["id"]: i for i, sec in enumerate(sectors_out)
    }
    # Add new sectors for industries that don't map well to the existing 12
    new_sectors = [
        ("chemicals", "Chemicals"),
        ("textiles", "Textiles"),
        ("media", "Media & Entertainment"),
        ("services", "Services & Others"),
    ]
    for sid, sname in new_sectors:
        if sid not in sector_id_map:
            sector_id_map[sid] = len(sectors_out)
            sectors_out.append({"id": sid, "name": sname, "stocks": []})

    added_count = 0
    # Process NSE stocks
    for sym, inst in lookup.items():
        isin = inst["isin"]
        if isin in placed_isins:
            continue
        name = clean_name(inst.get("name") or sym)
        sector_id = _classify_stock(sym, name, isin, nse_industry)
        if sector_id not in sector_id_map:
            sector_id = "services"
        idx = sector_id_map[sector_id]
        sectors_out[idx]["stocks"].append(
            {"sym": sym, "isin": isin, "name": name}
        )
        placed_isins.add(isin)
        added_count += 1

    # Process BSE-only stocks
    for sym, inst in bse_lookup.items():
        isin = inst["isin"]
        if isin in placed_isins:
            continue
        name = clean_name(inst.get("name") or sym)
        sector_id = _classify_stock(sym, name, isin, nse_industry)
        if sector_id not in sector_id_map:
            sector_id = "services"
        idx = sector_id_map[sector_id]
        sectors_out[idx]["stocks"].append(
            {"sym": sym, "isin": isin, "name": name}
        )
        placed_isins.add(isin)
        added_count += 1

    print(f"\nAuto-classified {added_count} additional stocks", file=sys.stderr)
    for sec in sectors_out:
        print(
            f"  [{sec['id']:22}] {sec['name']:35} {len(sec['stocks']):4} total",
            file=sys.stderr,
        )

    total_sector_stocks = sum(len(s["stocks"]) for s in sectors_out)

    # ── Price snapshot (v5) ──
    # Attach a last-traded-price to every stock so the swing tab's sector
    # cards can show the in-band count (₹400–₹2,200 by default) instead of
    # the raw total. Best-effort: needs the Upstox token in data/config.json.
    nse_isins = {inst["isin"] for inst in lookup.values()}
    attach_prices(sectors_out, indices_out, nse_isins, repo_root)

    payload = {
        "version": 5,
        "updated": date.today().isoformat(),
        "note": (
            "Auto-generated by scripts/tools/generate-sectors.py from the Upstox "
            "NSE + BSE instruments masters + NSE industry classification. "
            "Curated stocks are placed first (quality picks); remaining "
            "stocks auto-classified via NSE index industry tags + keyword "
            "matching. v5 adds a per-stock `price` (Upstox LTP snapshot at "
            "generation time) used by the sector cards to show how many "
            "names fall inside the tradeable price band; re-run to refresh. "
            "Missing `price` = Upstox couldn't quote it at gen time."
        ),
        "sectors": sectors_out,
        "indices": indices_out,
    }
    sectors_path.write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"\nWrote {sectors_path}",
        file=sys.stderr,
    )
    print(
        f"  sectors: {total_sector_stocks} stocks across {len(sectors_out)} sectors",
        file=sys.stderr,
    )
    print(
        f"  indices: {total_index_stocks} stocks across {len(indices_out)} indices",
        file=sys.stderr,
    )

    nse_count, bse_count = emit_instruments_index(
        lookup, bse_lookup, instruments_path
    )
    print(
        f"\nWrote {instruments_path} — {nse_count:,} NSE_EQ + {bse_count:,} "
        f"BSE-only stocks indexed ({nse_count + bse_count:,} total, "
        f"{instruments_path.stat().st_size / 1024:.0f} KB)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
