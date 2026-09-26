#!/usr/bin/env python3
"""Génère un modèle IFC4 de démonstration (FICTIF) pour tester l'import dans l'atlas.

Deux volumes (plot de 6 niveaux, tour de 12 niveaux), murs, dalles, toitures,
espaces avec surfaces, couleurs, et géoréférencement IfcMapConversion en
Lambert-93 (EPSG:2154) sur l'Île de Nantes.

Usage : python3 tools/generer-ifc-demo.py [sortie.ifc]
Nécessite : pip install ifcopenshell pyproj numpy
"""
import math
import sys

import numpy as np
import ifcopenshell
import ifcopenshell.api
from pyproj import Transformer

run = ifcopenshell.api.run
SORTIE = sys.argv[1] if len(sys.argv) > 1 else "projet-demonstration.ifc"

# Point d'insertion (WGS84) et orientation du repère projet (axe X à 12,5° de l'est du quadrillage Lambert-93).
LON, LAT, ALTITUDE = -1.5585, 47.2043, 5.0
ANGLE = math.radians(12.5)
E, N = Transformer.from_crs("EPSG:4326", "EPSG:2154", always_xy=True).transform(LON, LAT)

f = run("project.create_file", version="IFC4")
projet = run("root.create_entity", f, ifc_class="IfcProject", name="Projet de démonstration (fictif)")
run("unit.assign_unit", f, length={"is_metric": True, "raw": "METERS"}, area={"is_metric": True, "raw": "SQUARE_METRE"})
modele = run("context.add_context", f, context_type="Model")
corps = run("context.add_context", f, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=modele)

run("georeference.add_georeferencing", f)
run("georeference.edit_georeferencing", f,
    projected_crs={"Name": "EPSG:2154", "Description": "RGF93 v1 / Lambert-93"},
    coordinate_operation={"Eastings": E, "Northings": N, "OrthogonalHeight": ALTITUDE,
                          "XAxisAbscissa": math.cos(ANGLE), "XAxisOrdinate": math.sin(ANGLE), "Scale": 1.0})

site = run("root.create_entity", f, ifc_class="IfcSite", name="Parcelle de démonstration")
batiment = run("root.create_entity", f, ifc_class="IfcBuilding", name="Îlot démonstrateur")
run("aggregate.assign_object", f, relating_object=projet, products=[site])
run("aggregate.assign_object", f, relating_object=site, products=[batiment])


def style(nom, r, g, b, transparence=0.0):
    s = run("style.add_style", f, name=nom)
    run("style.add_surface_style", f, style=s, ifc_class="IfcSurfaceStyleShading",
        attributes={"SurfaceColour": {"Name": None, "Red": r, "Green": g, "Blue": b}, "Transparency": transparence})
    return s


BETON = style("Béton clair", 0.90, 0.88, 0.84)
BOIS = style("Bardage bois", 0.72, 0.56, 0.38)
DALLE = style("Dalle", 0.62, 0.62, 0.64)
TOIT = style("Toiture végétalisée", 0.45, 0.60, 0.38)


def placement(produit, x, y, z, rotation=0.0):
    m = np.eye(4)
    m[0][0], m[0][1], m[1][0], m[1][1] = math.cos(rotation), -math.sin(rotation), math.sin(rotation), math.cos(rotation)
    m[0][3], m[1][3], m[2][3] = x, y, z
    run("geometry.edit_object_placement", f, product=produit, matrix=m, is_si=True)


def mur(niveau, x0, y0, x1, y1, z, hauteur, epaisseur, st):
    w = run("root.create_entity", f, ifc_class="IfcWall", name="Mur")
    longueur = math.hypot(x1 - x0, y1 - y0)
    rep = run("geometry.add_wall_representation", f, context=corps, length=longueur, height=hauteur, thickness=epaisseur)
    run("geometry.assign_representation", f, product=w, representation=rep)
    run("style.assign_representation_styles", f, shape_representation=rep, styles=[st])
    placement(w, x0, y0, z, math.atan2(y1 - y0, x1 - x0))
    run("spatial.assign_container", f, relating_structure=niveau, products=[w])


def dalle(niveau, contour, z, epaisseur, st, classe="IfcSlab", nom="Dalle"):
    s = run("root.create_entity", f, ifc_class=classe, name=nom)
    rep = run("geometry.add_slab_representation", f, context=corps, depth=epaisseur, polyline=contour)
    run("geometry.assign_representation", f, product=s, representation=rep)
    run("style.assign_representation_styles", f, shape_representation=rep, styles=[st])
    placement(s, 0, 0, z)
    run("spatial.assign_container", f, relating_structure=niveau, products=[s])


def aire(contour):
    return abs(sum(contour[i][0] * contour[(i + 1) % len(contour)][1] - contour[(i + 1) % len(contour)][0] * contour[i][1]
                   for i in range(len(contour)))) / 2


def espace(niveau, contour, z, hauteur, nom):
    e = run("root.create_entity", f, ifc_class="IfcSpace", name=nom)
    run("aggregate.assign_object", f, relating_object=niveau, products=[e])
    q = run("pset.add_qto", f, product=e, name="Qto_SpaceBaseQuantities")
    run("pset.edit_qto", f, qto=q, properties={"NetFloorArea": round(aire(contour) * 0.88, 1),
                                               "GrossFloorArea": round(aire(contour), 1), "Height": hauteur})


def volume(contour, niveaux, hauteur_niveau, st_mur, prefixe, depart=0):
    """Extrusion d'un contour sur plusieurs niveaux : murs, dalles, toiture, espaces."""
    for i in range(niveaux):
        z = (depart + i) * hauteur_niveau
        nom = f"{prefixe} R+{depart + i}" if depart + i else f"{prefixe} RDC"
        niveau = run("root.create_entity", f, ifc_class="IfcBuildingStorey", name=nom)
        niveau.Elevation = z
        run("aggregate.assign_object", f, relating_object=batiment, products=[niveau])
        dalle(niveau, contour, z, 0.25, DALLE)
        for k in range(len(contour)):
            (x0, y0), (x1, y1) = contour[k], contour[(k + 1) % len(contour)]
            mur(niveau, x0, y0, x1, y1, z + 0.25, hauteur_niveau - 0.25, 0.3, st_mur)
        espace(niveau, contour, z, hauteur_niveau, f"Plateau {nom}")
        if i == niveaux - 1:
            dalle(niveau, contour, z + hauteur_niveau, 0.4, TOIT, "IfcSlab", "Toiture")


# Plot en L de 6 niveaux et tour de 12 niveaux (repère projet, mètres).
PLOT = [(0, 0), (42, 0), (42, 14), (14, 14), (14, 32), (0, 32)]
TOUR = [(24, 20), (40, 20), (40, 36), (24, 36)]
volume(PLOT, 6, 3.1, BETON, "Plot")
volume(TOUR, 12, 3.1, BOIS, "Tour")

f.write(SORTIE)
print(f"Écrit {SORTIE} — origine Lambert-93 E={E:.2f} N={N:.2f}, orientation 12,5°")
