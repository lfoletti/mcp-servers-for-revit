# -*- coding: utf-8 -*-
"""
planbook — automatisation de la création des plans et vues liés au modèle
=========================================================================

Fonction-parent qui orchestre plusieurs **sous-fonctions**, chacune générant
une famille de vues/feuilles à partir du modèle Revit. Chaque sous-fonction est
un module exposant `run(doc, cfg=None, log=None)` qui **suppose une Transaction
ouverte** (planbook la gère) et retourne le nombre de feuilles créées.

Sous-fonctions
--------------
- ``enlarged_plans`` — une feuille "Enlarged Plan" par pièce (crop = contour,
  échelle auto, config de vue complète, DWG masqués, 1 feuille/niveau).  ✅

À venir (même patron `run(doc, cfg, log)`) :
- ``facade_plans`` / ``facade_elevations`` — plans & élévations de façade ;
- ``sections`` — coupes AA/BB… placées et cadrées ;
- ``furniture_plans`` / ``flooring_plans`` / ``ceiling_plans`` — plans thématiques ;
- ``dimensions`` / ``tags`` — annotations automatiques.

Usage
-----
    from planbook import run_planbook
    run_planbook(doc)                         # toutes les sous-fonctions activées
    run_planbook(doc, only=["enlarged_plans"])
    run_planbook(doc, config={"enlarged_plans": {"onExisting": "duplicate"}})

Voir ``pyrevit/run_planbook.py`` pour le point d'entrée actionnable PyRevit.
"""

from Autodesk.Revit.DB import Transaction

from . import enlarged_plans

# Registre des sous-fonctions : nom -> module exposant run(doc, cfg, log).
# Ajouter une sous-fonction = l'importer et l'enregistrer ici.
SUBFUNCTIONS = [
    ("enlarged_plans", enlarged_plans),
]


def run_planbook(doc, only=None, config=None, log=None):
    """Exécute les sous-fonctions planbook dans **une seule Transaction**.

    - ``only`` : liste de noms de sous-fonctions à exécuter (défaut : toutes).
    - ``config`` : dict {nom_sous_fonction: cfg} pour surcharger la config.
    - ``log`` : callable(str) (défaut : print).

    Retourne un dict {nom: nb_feuilles_créées}.
    """
    log = log or _default_log
    config = config or {}
    results = {}

    t = Transaction(doc, "planbook")
    t.Start()
    try:
        for name, mod in SUBFUNCTIONS:
            if only and name not in only:
                continue
            log("### planbook: {0}".format(name))
            results[name] = mod.run(doc, config.get(name), log)
        t.Commit()
    except Exception:
        t.RollBack()
        raise

    total = sum(results.values())
    log("=== planbook terminé : {0} feuille(s) sur {1} sous-fonction(s) ===".format(
        total, len(results)))
    return results


def _default_log(msg):
    print(msg)
