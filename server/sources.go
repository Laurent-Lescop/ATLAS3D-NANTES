package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Centre de référence (Nantes, place Royale) pour la météo.
const (
	nantesLat = "47.2173"
	nantesLon = "-1.5534"
)

const odsBase = "https://data.nantesmetropole.fr/api/explore/v2.1/catalog/datasets/"

func get(u string) func(url.Values) (*http.Request, string, error) {
	return func(url.Values) (*http.Request, string, error) {
		req, err := http.NewRequest(http.MethodGet, u, nil)
		return req, "", err
	}
}

func declareSources() map[string]*Source {
	meteo := url.Values{
		"latitude":  {nantesLat},
		"longitude": {nantesLon},
		"current": {"temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code," +
			"cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,shortwave_radiation,uv_index"},
		"hourly": {"temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation," +
			"weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,shortwave_radiation,uv_index"},
		"daily":           {"sunrise,sunset,temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_sum"},
		"timezone":        {"Europe/Paris"},
		"past_days":       {"1"},
		"forecast_days":   {"3"},
		"wind_speed_unit": {"kmh"},
	}
	air := url.Values{
		"latitude":  {nantesLat},
		"longitude": {nantesLon},
		"current": {"european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone," +
			"alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen"},
		"hourly":        {"european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone"},
		"timezone":      {"Europe/Paris"},
		"forecast_days": {"2"},
	}

	return map[string]*Source{
		// Météo actuelle et prévisions (Open-Meteo, gratuit pour un usage non commercial).
		"meteo": {TTL: 10 * time.Minute, Request: get("https://api.open-meteo.com/v1/forecast?" + meteo.Encode())},
		// Qualité de l'air et pollens (Open-Meteo / CAMS).
		"air": {TTL: 30 * time.Minute, Request: get("https://air-quality-api.open-meteo.com/v1/air-quality?" + air.Encode())},
		// Hauteur de la Loire au pont Anne-de-Bretagne (Hub'Eau, mm).
		"loire": {TTL: 10 * time.Minute, Timeout: 60 * time.Second, Request: get(
			"https://hubeau.eaufrance.fr/api/v2/hydrometrie/observations_tr?code_entite=M800001010" +
				"&grandeur_hydro=H&size=300&sort=desc&fields=date_obs,resultat_obs")},

		// Mobilités (Nantes Métropole, données ouvertes).
		"fluidite": {TTL: 3 * time.Minute, Request: get(odsBase +
			"244400404_fluidite-axes-routiers-nantes-metropole/exports/geojson")},
		"parkings": {TTL: 2 * time.Minute, Request: get(odsBase +
			"244400404_parkings-publics-nantes-disponibilites/exports/json")},
		"velos-stations": {TTL: 24 * time.Hour, Request: get(
			"https://api.cyclocity.fr/contracts/nantes/gbfs/v3/station_information.json")},
		"velos-etat": {TTL: 60 * time.Second, Request: get(
			"https://api.cyclocity.fr/contracts/nantes/gbfs/v3/station_status.json")},
		"naolib-retards": {TTL: 45 * time.Second, Request: get(
			"https://proxy.transport.data.gouv.fr/resource/naolib-nantes-gtfs-rt-trip-update"),
			Transform: decodeTripUpdates},
		"naolib-alertes": {TTL: 5 * time.Minute, Request: get(
			"https://proxy.transport.data.gouv.fr/resource/naolib-nantes-gtfs-rt-alerts"),
			Transform: decodeAlerts},
		"calendrier-scolaire": {TTL: 7 * 24 * time.Hour, Request: get(
			"https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/exports/json" +
				"?where=" + url.QueryEscape(`zones="Zone B" and location="Nantes"`) +
				"&select=description,start_date,end_date,annee_scolaire")},

		// Bâtiments OpenStreetMap d'une zone (Overpass), mis en cache 30 jours.
		"osm-batiments": {TTL: 30 * 24 * time.Hour, Timeout: 180 * time.Second, Request: overpassBuildings},
		// Bâtiments BD TOPO de l'IGN (hauteurs, dates, usages) d'une zone.
		"bdtopo-batiments": {TTL: 30 * 24 * time.Hour, Timeout: 180 * time.Second, KeyOf: bboxKey, Fetch: bdtopoBuildings},
	}
}

// parseBBox lit « bbox=ouest,sud,est,nord » et vérifie une taille raisonnable.
func parseBBox(q url.Values) ([4]float64, error) {
	var b [4]float64
	parts := strings.Split(q.Get("bbox"), ",")
	if len(parts) != 4 {
		return b, fmt.Errorf("paramètre bbox attendu : ouest,sud,est,nord")
	}
	for i, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return b, fmt.Errorf("bbox invalide")
		}
		b[i] = v
	}
	if b[0] >= b[2] || b[1] >= b[3] || b[1] < -85 || b[3] > 85 {
		return b, fmt.Errorf("bbox invalide")
	}
	if (b[2]-b[0])*(b[3]-b[1]) > 0.006 {
		return b, fmt.Errorf("zone trop grande pour un chargement en ligne (maximum ≈ 40 km²)")
	}
	return b, nil
}

func bboxKey(q url.Values) (string, error) {
	b, err := parseBBox(q)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%.4f_%.4f_%.4f_%.4f", b[0], b[1], b[2], b[3]), nil
}

func overpassBuildings(q url.Values) (*http.Request, string, error) {
	b, err := parseBBox(q)
	if err != nil {
		return nil, "", err
	}
	key, _ := bboxKey(q)
	box := fmt.Sprintf("%.6f,%.6f,%.6f,%.6f", b[1], b[0], b[3], b[2]) // sud,ouest,nord,est
	query := "[out:json][timeout:170];(" +
		`way["building"](` + box + `);` +
		`relation["building"]["type"="multipolygon"](` + box + `);` +
		`way["building:part"](` + box + `);` +
		`relation["building:part"]["type"="multipolygon"](` + box + `);` +
		");out tags geom qt;"
	form := url.Values{"data": {query}}
	req, err := http.NewRequest(http.MethodPost, "https://overpass-api.de/api/interpreter",
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return req, key, nil
}

// bdtopoBuildings interroge le service WFS de la Géoplateforme IGN page par page.
func bdtopoBuildings(ctx context.Context, q url.Values) ([]byte, string, string, error) {
	b, err := parseBBox(q)
	if err != nil {
		return nil, "", "", err
	}
	key, _ := bboxKey(q)
	client := &http.Client{Timeout: 90 * time.Second}
	const page = 5000
	var features []json.RawMessage
	for start := 0; start < 200000; start += page {
		params := url.Values{
			"SERVICE":      {"WFS"},
			"VERSION":      {"2.0.0"},
			"REQUEST":      {"GetFeature"},
			"TYPENAMES":    {"BDTOPO_V3:batiment"},
			"OUTPUTFORMAT": {"application/json"},
			"COUNT":        {strconv.Itoa(page)},
			"STARTINDEX":   {strconv.Itoa(start)},
			"SORTBY":       {"cleabs"},
			"PROPERTYNAME": {"geometrie,cleabs,hauteur,nombre_d_etages,date_d_apparition,usage_1,usage_2," +
				"nombre_de_logements,altitude_minimale_sol,altitude_minimale_toit,altitude_maximale_toit,identifiants_rnb"},
			"BBOX": {fmt.Sprintf("%.6f,%.6f,%.6f,%.6f,urn:ogc:def:crs:EPSG::4326", b[1], b[0], b[3], b[2])},
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://data.geopf.fr/wfs/ows?"+params.Encode(), nil)
		body, _, err := doRequest(client, req)
		if err != nil {
			return nil, "", "", err
		}
		var fc struct {
			Features []json.RawMessage `json:"features"`
		}
		if err := json.Unmarshal(body, &fc); err != nil {
			return nil, "", "", fmt.Errorf("réponse BD TOPO illisible : %w", err)
		}
		features = append(features, fc.Features...)
		if len(fc.Features) < page {
			break
		}
	}
	var buf bytes.Buffer
	buf.WriteString(`{"type":"FeatureCollection","features":[`)
	for i, f := range features {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(f)
	}
	buf.WriteString("]}")
	return buf.Bytes(), "application/geo+json", key, nil
}
