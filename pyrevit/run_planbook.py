# -*- coding: utf-8 -*-
"""
Point d'entrée PyRevit — lance **planbook** sur le document actif.

Placer ce fichier (et le package `planbook/`) dans une extension PyRevit, ou
l'exécuter directement. Il ajoute son dossier au `sys.path` pour importer le
package `planbook` voisin.

Adapter la dernière ligne pour cibler certaines sous-fonctions ou surcharger la
config, ex. :

    run_planbook(doc, only=["enlarged_plans"],
                 config={"enlarged_plans": {"onExisting": "duplicate"}}, log=log)
"""

import os
import sys

sys.path.append(os.path.dirname(__file__))   # rend le package `planbook` importable

try:
    from pyrevit import revit, script
    doc = revit.doc
    log = script.get_output().print_md
except Exception:
    doc = __revit__.ActiveUIDocument.Document   # noqa: F821
    def log(m):
        print(m)

from planbook import run_planbook

run_planbook(doc, log=log)
