cat <<EOF
# kept in a heredoc
x # kept
EOF
echo "$#" ${#HOME} a#b # gone
x=abc; echo ${x#a} # gone
echo '# quoted' \# escaped
